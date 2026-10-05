/**
 * The extraction pipeline (the v0.15 proposal-based write path B): one
 * bounded increment of one session, one LLM call, one gated transactional
 * application, one ledger row, one cursor.
 *
 * Trigger economics (plan `2026-10-06-v0.15-sqlite-memory-store.md` §3):
 * turn-level, not step-level — every `agent/turn-stopping` (re)arms an idle
 * debounce timer (default 10 min, `memoryIndex.debounceMin`); a run in
 * flight means new turns only refresh the pending boundary (single-flight
 * coalescing); `compaction/start` and session close flush immediately.
 * Everything the pipeline decides mechanically (internal agent, empty
 * increment, no real user prose, an explicit `memory_write` this turn) is
 * skipped AND ledgered — the extraction_log is the account the economics
 * are audited against.
 *
 * The model proposes; the store disposes. A failed or rejected run never
 * advances the cursor, so the increment is retried on the next trigger.
 */
import type { MemoryProposal } from "./memory-rules.js";
import { boundaryCursorOf, evaluateSlice, eventsAfterCursor, isInternalAgent, seqOfCursor, serializeIncrement, type SkipReason, type SurfaceReader } from "./extraction-surface.js";
import { EXTRACTION_SYSTEM_PROMPT, extractionPrompt, manifestLineOf, parseExtractionAnswer } from "./extraction-prompt.js";
import type { LedgerEntry, MemoryStore } from "./store.js";
import { cwdOf } from "./memory-section.js";

/** The minimal LLM face extraction calls (duck-typed host service). */
export interface LlmStream {
	stream(options: Record<string, unknown>): AsyncIterable<unknown>;
}

/** Everything a run needs: the store, the session reader, and the LLM. */
export interface ExtractionDeps {
	store: MemoryStore;
	surface: SurfaceReader | undefined;
	llm: LlmStream | undefined;
}

/** One extraction target: whose session, in which workspace, on which route. */
export interface ExtractionTarget {
	workspaceId: string | undefined;
	sessionId: string;
	internalAgent: boolean;
	provider: string | undefined;
	model: string | undefined;
}

/** Terminal outcome of one run. */
export interface ExtractionResult {
	status: "applied" | "rejected" | "skipped" | "failed";
	skipReason?: SkipReason | string | undefined;
	/** Mutations landed (status "applied"). */
	applied?: number | undefined;
	/** The seq boundary the cursor advanced to (status "applied" or model skip). */
	cursor?: number | undefined;
}

/** Options for one run. */
export interface RunOptions {
	trigger: LedgerEntry["trigger"];
	/** Character ceiling for the serialized increment (default 40000). */
	incrementMaxChars?: number;
}

/**
 * Run one extraction pass for a target. Never throws: every terminal path
 * is either a landed application, a ledgered skip, or a ledgered failure.
 */
export async function runExtraction(deps: ExtractionDeps, target: ExtractionTarget, opts: RunOptions): Promise<ExtractionResult> {
	const { store } = deps;
	const ledgerBase = {
		sessionId: target.sessionId,
		workspaceId: target.workspaceId,
		trigger: opts.trigger,
	};
	if (target.internalAgent) {
		store.logSkipped({ ...ledgerBase, skipReason: "internal-agent", status: "skipped" });
		return { status: "skipped", skipReason: "internal-agent" };
	}
	if (target.workspaceId === undefined) {
		store.logSkipped({ ...ledgerBase, skipReason: "no-workspace", status: "skipped" });
		return { status: "skipped", skipReason: "no-workspace" };
	}
	if (deps.surface === undefined) {
		store.logSkipped({ ...ledgerBase, skipReason: "no-surface", status: "skipped" });
		return { status: "skipped", skipReason: "no-surface" };
	}
	if (target.provider === undefined || target.model === undefined || deps.llm === undefined) {
		store.logSkipped({ ...ledgerBase, skipReason: "no-route", status: "skipped" });
		return { status: "skipped", skipReason: "no-route" };
	}

	const cursor = store.cursor(target.workspaceId, target.sessionId);
	let all: readonly unknown[];
	try {
		const snapshot = await deps.surface.readSurface(target.sessionId);
		all = Array.isArray(snapshot.events) ? snapshot.events : [];
	} catch (error) {
		store.logSkipped({ ...ledgerBase, skipReason: "surface-read-failed", status: "failed" });
		return { status: "failed", skipReason: `surface read failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const events = eventsAfterCursor(all, cursor === undefined ? undefined : `seq:${cursor}`);
	const slice = evaluateSlice({ events, internalAgent: false });
	if (!slice.eligible) {
		store.logSkipped({ ...ledgerBase, skipReason: slice.skipReason, status: "skipped" });
		return { status: "skipped", skipReason: slice.skipReason };
	}

	const boundary = boundaryCursorOf(all);
	const boundarySeq = seqOfCursor(boundary);
	const workspaceId: string = target.workspaceId;
	const advanceCursor = () => {
		if (boundarySeq !== undefined) {
			store.setCursor(workspaceId, target.sessionId, boundarySeq);
		}
	};

	const increment = serializeIncrement(slice.events, opts.incrementMaxChars);
	const manifest = store.list(target.workspaceId).slice(0, 50).map(manifestLineOf);
	const candidates = candidateRecords(store, target.workspaceId, slice.userText);
	const prompt = extractionPrompt({
		increment,
		manifest,
		candidates: candidates.map(formatCandidate),
		userSeqs: slice.userSeqs,
	});

	const started = Date.now();
	let text: string;
	let usage: unknown;
	try {
		const answer = await streamOnce(deps.llm, target, prompt);
		text = answer.text;
		usage = answer.usage;
	} catch (error) {
		store.logSkipped({ ...ledgerBase, skipReason: "llm-failed", status: "failed", durationMs: Date.now() - started });
		return { status: "failed", skipReason: `llm call failed: ${error instanceof Error ? error.message : String(error)}` };
	}

	const parsed = parseExtractionAnswer(text);
	if (parsed.decision === "error") {
		// A malformed answer is a failed run: the increment stays unconsumed
		// and the next trigger retries it.
		store.logSkipped({
			...ledgerBase,
			skipReason: parsed.reason,
			status: "failed",
			model: target.model,
			usage,
			durationMs: Date.now() - started,
		});
		return { status: "failed", skipReason: parsed.reason };
	}
	if (parsed.decision === "skip") {
		// A real model decision (even "nothing worth keeping") consumed the
		// increment — advancing the cursor here is what keeps retries honest.
		advanceCursor();
		store.logSkipped({
			...ledgerBase,
			skipReason: `model-skip: ${parsed.reason}`,
			status: "skipped",
			model: target.model,
			usage,
			durationMs: Date.now() - started,
		});
		return { status: "skipped", skipReason: parsed.reason, cursor: boundarySeq };
	}

	const outcomes = store.applyProposals(
		{
			workspaceId: target.workspaceId,
			trigger: opts.trigger,
			sessionId: target.sessionId,
			runId: `extract:${target.sessionId}:${boundarySeq ?? "tail"}`,
			model: target.model,
			usage,
			decision: parsed.reason,
		},
		parsed.proposals as MemoryProposal[],
	);
	if (!outcomes.every((outcome) => outcome.ok)) {
		return { status: "rejected", skipReason: outcomes.find((outcome) => !outcome.ok)?.reason };
	}
	advanceCursor();
	// Hygiene rides on every applied run: orphan FTS rows dropped, secret
	// leakage quarantined — never a separate scheduler.
	const patrol = store.patrol();
	void patrol;
	return { status: "applied", applied: outcomes.filter((outcome) => outcome.ok).length, cursor: boundarySeq };
}

/** Similar existing memories (full bodies) for the model to update against. */
function candidateRecords(store: MemoryStore, workspaceId: string, userText: string): ReturnType<MemoryStore["search"]> {
	const query = userText.split("\n")[0]?.slice(0, 100).trim() ?? "";
	const hits = query.length >= 3 ? store.search(workspaceId, query, 8) : [];
	return hits.length > 0 ? hits : store.list(workspaceId).slice(0, 8);
}

function formatCandidate(record: { id: string; type: string; title: string; description: string; body: string }): string {
	return [`# 候选 id=${record.id}（type=${record.type}）`, `title=${record.title}`, `钩子=${record.description}`, "全文：", record.body].join("\n");
}

/** One streaming text call with the host session identity forwarded. */
async function streamOnce(
	llm: LlmStream,
	target: ExtractionTarget,
	prompt: string,
): Promise<{ text: string; usage: unknown }> {
	let text = "";
	let usage: unknown;
	let finish: { kind?: string } | undefined;
	const options: Record<string, unknown> = {
		provider: target.provider,
		model: target.model,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		system: EXTRACTION_SYSTEM_PROMPT,
		maxTokens: 4096,
		// MissingSessionID pitfall: direct calls must carry the host session.
		sessionId: target.sessionId,
	};
	for await (const chunk of llm.stream(options)) {
		const piece = chunk as { type?: string; text?: unknown; usage?: unknown; reason?: { kind?: string } };
		if (piece?.type === "text-delta" && typeof piece.text === "string") {
			text += piece.text;
		} else if (piece?.type === "usage") {
			usage = piece.usage;
		} else if (piece?.type === "finish") {
			finish = piece.reason;
		}
	}
	if (finish !== undefined && finish.kind !== "stop") {
		throw new Error(`stream finished with ${finish.kind ?? "unknown"}`);
	}
	if (text.trim().length === 0) {
		throw new Error("empty model output");
	}
	return { text, usage };
}

/** One pending extraction target (the coalescing slot). */
interface PendingTarget {
	agent: unknown;
	sessionId: string;
	provider: string | undefined;
	model: string | undefined;
}

/** The event wiring surface (duck-typed cordis context). */
export interface SchedulerHost {
	on(event: string, handler: (...args: never[]) => void): unknown;
	logger(name: string): { info(message: string): void; warn(message: string): void };
}

export interface SchedulerOptions {
	/** Idle debounce in minutes (default 10); 0 fires on every turn. */
	debounceMin?: number;
}

/**
 * Wire the extraction triggers onto the host context. Returns a disposer
 * that removes the listeners and clears the timer. The scheduler is the
 * only background automation the plugin runs, and it is bounded by design:
 * one timer, one in-flight run, one pending slot.
 */
export function createExtractionScheduler(
	host: SchedulerHost,
	deps: ExtractionDeps,
	options: SchedulerOptions = {},
): () => void {
	const debounceMs = Math.max(0, (options.debounceMin ?? 10) * 60_000);
	const listeners: unknown[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let pending: PendingTarget | null = null;

	const targetOf = (agent: unknown): PendingTarget | null => {
		const id = (agent as { id?: unknown } | undefined)?.id;
		if (typeof id !== "string" || id.length === 0) {
			return null;
		}
		const route = (agent as { options?: { provider?: unknown; model?: unknown } } | undefined)?.options;
		return {
			agent,
			sessionId: id,
			provider: typeof route?.provider === "string" ? route.provider : undefined,
			model: typeof route?.model === "string" ? route.model : undefined,
		};
	};

	const flush = (trigger: LedgerEntry["trigger"]): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (running || pending === null) {
			return;
		}
		const target = pending;
		pending = null;
		running = true;
		void runExtraction(
			deps,
			{
				workspaceId: cwdOf(target.agent),
				sessionId: target.sessionId,
				internalAgent: isInternalAgent(target.agent),
				provider: target.provider,
				model: target.model,
			},
			{ trigger },
		).catch((error: unknown) => {
			host.logger("continual-evolve").warn(
				`extraction run failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
			);
		}).finally(() => {
			running = false;
			if (pending !== null) {
				// A turn arrived mid-run and refreshed the pending slot: drain it.
				flush("turn-debounce");
			}
		});
	};

	const arm = (agent: unknown): void => {
		const target = targetOf(agent);
		if (target === null) {
			return;
		}
		pending = target; // Coalescing: the latest boundary wins, nothing queues.
		if (debounceMs === 0) {
			flush("turn-debounce");
			return;
		}
		if (timer !== null) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = null;
			flush("turn-debounce");
		}, debounceMs);
	};

	listeners.push(
		host.on("agent/turn-stopping", (payload: { agent?: unknown }) => {
			if (payload.agent === undefined) {
				return;
			}
			arm(payload.agent);
		}),
	);
	listeners.push(
		host.on("session/event", (session: { id?: unknown }, event: { type?: unknown }) => {
			if (event?.type !== "compaction/start" || pending === null || pending.sessionId !== session?.id) {
				return;
			}
			flush("compaction");
		}),
	);
	listeners.push(
		host.on("agent/disposed", (payload: { agent?: unknown }) => {
			const id = (payload.agent as { id?: unknown } | undefined)?.id;
			if (pending === null || pending.sessionId !== id) {
				return;
			}
			flush("close-drain");
		}),
	);
	host.logger("continual-evolve").info(
		`extraction scheduler armed (debounce ${options.debounceMin ?? 10}min, single-flight with coalescing)`,
	);
	return () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pending = null;
		for (const listener of listeners) {
			if (typeof listener === "function") {
				listener();
			}
		}
	};
}
