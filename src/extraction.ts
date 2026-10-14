/**
 * The extraction pipeline (the v0.15 proposal-based write path B): one
 * bounded increment of one session, one LLM call, one gated transactional
 * application, one ledger row, one cursor.
 *
 * Trigger economics follow ZCode's memory-extraction scheduler: turn-level
 * (every `agent/turn-stopping` schedules that session's boundary), no idle
 * timer, and state per session — a session with a run in flight keeps only
 * its newest boundary, which the run drains when it finishes (coalescing,
 * not queueing); `compaction/start` and session close drain immediately.
 * Per-session slots mean one workspace's turns can never delay or displace
 * another's extraction. Everything the pipeline decides mechanically
 * (internal agent, empty increment, no real user prose, an explicit
 * `memory_write` this turn) is skipped AND ledgered — the extraction_log is
 * the account the economics are audited against. Consecutive repeats of one
 * session's quiet-turn skip share a single row there, counted in
 * `occurrences` (see `store.ts`), so the account stays readable at volume.
 *
 * This module owns the entry, the failure net, and the scheduler; the pass
 * itself is a responsibility chain (`extraction-ring.ts`) the entry assembles.
 * The model proposes; the store disposes. A failed or rejected run never
 * advances the cursor, so the increment is retried on the next trigger.
 */
import { ERROR_REASON_MAX, errorText, runExtractionInner } from "./extraction-ring.js";
import { isInternalAgent, type SkipReason, type SurfaceReader } from "./extraction-surface.js";
import type { LedgerEntry, MemoryStore } from "./store.js";
import { cwdOf } from "./memory-section.js";
import { resolveCallRoute, type LlmRuntime, type RouteResolver } from "./llm-call.js";
import type { PluginLog } from "./plugin-log.js";

export type { LlmStream, LlmRuntime, RouteResolver } from "./llm-call.js";

/** Everything a run needs: the store, the session reader, and the LLM. */
export interface ExtractionDeps {
	store: MemoryStore;
	surface: SurfaceReader | undefined;
	llm: LlmRuntime | undefined;
	/**
	 * Route resolution for a direct call: the agent's explicit selection first,
	 * the host default model second. Absent keeps the legacy agent-options-only
	 * behavior (tests and older hosts).
	 */
	resolveRoute?: RouteResolver | undefined;
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
	/** Baseline day `YYYY-MM-DD` (UTC) the prompts judge dates by; defaults to the run's wall clock. */
	today?: string | undefined;
}

/**
 * Run one extraction pass for a target. Never throws unless the ledger
 * itself is unwritable: every terminal path is either a landed application,
 * a ledgered skip, or a ledgered failure — anything that escapes the
 * per-stage handling inside lands a failed `unexpected-error` ledger row
 * here, so no failure ends as a scheduler warn without an account trace.
 */
export async function runExtraction(deps: ExtractionDeps, target: ExtractionTarget, opts: RunOptions): Promise<ExtractionResult> {
	const started = Date.now();
	try {
		return await runExtractionInner(deps, target, opts);
	} catch (error) {
		const { message, detail } = errorText(error);
		const reason = `unexpected-error: ${message.slice(0, ERROR_REASON_MAX)}`;
		try {
			deps.store.logSkipped({
				sessionId: target.sessionId,
				workspaceId: target.workspaceId,
				trigger: opts.trigger,
				skipReason: reason,
				status: "failed",
				model: target.model,
				durationMs: Date.now() - started,
				files: detail,
			});
		} catch (ledgerError) {
			// The ledger itself is down — nothing left to write to. Chain
			// both errors so the scheduler's last-resort row keeps the
			// triggering failure, not just the ledger fault.
			throw new Error(`extraction failed (${message}); failure ledger write also failed (${errorText(ledgerError).message})`);
		}
		return { status: "failed", skipReason: reason };
	}
}

/** One pending extraction target (its session's coalescing slot). */
interface PendingTarget {
	agent: unknown;
	sessionId: string;
	provider: string | undefined;
	model: string | undefined;
}

/** One session's scheduling slot: a run in flight plus its newest boundary. */
interface SessionSlot {
	pending: PendingTarget | null;
	running: boolean;
}

/** The event wiring surface (duck-typed cordis context). */
export interface SchedulerHost {
	on(event: string, handler: (...args: never[]) => void): unknown;
	/** The plugin's own log face: durable in the store, mirrored live. */
	log: PluginLog;
}

/**
 * Wire the extraction triggers onto the host context. Returns a disposer
 * that removes the listeners. The scheduler is the only background
 * automation the plugin runs, and it is bounded by design: one boundary and
 * one in-flight run per session.
 */
export function createExtractionScheduler(host: SchedulerHost, deps: ExtractionDeps): () => void {
	const listeners: unknown[] = [];
	const slots = new Map<string, SessionSlot>();

	const slotOf = (sessionId: string): SessionSlot => {
		let slot = slots.get(sessionId);
		if (slot === undefined) {
			slot = { pending: null, running: false };
			slots.set(sessionId, slot);
		}
		return slot;
	};

	const targetOf = (agent: unknown): PendingTarget | null => {
		const id = (agent as { id?: unknown } | undefined)?.id;
		if (typeof id !== "string" || id.length === 0) {
			return null;
		}
		// Absent resolver (older host, tests) still reads the agent's explicit
		// selection: the fallback is the legacy behavior, never "no route".
		const route = deps.resolveRoute?.(agent) ?? resolveCallRoute(agent, undefined);
		return {
			agent,
			sessionId: id,
			provider: route?.provider,
			model: route?.model,
		};
	};

	const drain = (sessionId: string, trigger: LedgerEntry["trigger"]): void => {
		const slot = slotOf(sessionId);
		if (slot.running || slot.pending === null) {
			return;
		}
		const target = slot.pending;
		slot.pending = null;
		slot.running = true;
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
			// Last resort: runExtraction ledgers its own unexpected failures,
			// so this fires only when even that failed (the ledger write
			// threw) — retry one ledger row here before the warn, so the
			// failure still has an account trace.
			const { message, detail } = errorText(error);
			try {
				deps.store.logSkipped({
					sessionId: target.sessionId,
					workspaceId: cwdOf(target.agent),
					trigger,
					skipReason: `unexpected-error: ${message.slice(0, ERROR_REASON_MAX)}`,
					status: "failed",
					model: target.model,
					files: detail,
				});
			} catch {
				// The ledger is down — the warn below is the last resort.
			}
			host.log.warn("extraction-unexpected", `run failed unexpectedly: ${message}`, { sessionId });
		}).finally(() => {
			slot.running = false;
			if (slot.pending !== null) {
				// A turn landed mid-run: the newest boundary is the one to run.
				drain(sessionId, "turn-debounce");
			}
		});
	};

	/**
	 * Schedule one session's boundary. Internal agents (subagents and DSH
	 * internal agents) are filtered at this entry rather than inside the run:
	 * they are not memory sources, so they never occupy a slot, never drain
	 * another session's boundary, and leave no ledger rows behind.
	 */
	const schedule = (agent: unknown): void => {
		if (isInternalAgent(agent)) {
			return;
		}
		const target = targetOf(agent);
		if (target === null) {
			return;
		}
		slotOf(target.sessionId).pending = target;
		drain(target.sessionId, "turn-debounce");
	};

	listeners.push(
		host.on("agent/turn-stopping", (payload: { agent?: unknown }) => {
			if (payload.agent === undefined) {
				return;
			}
			schedule(payload.agent);
		}),
	);
	listeners.push(
		host.on("session/event", (session: { id?: unknown }, event: { type?: unknown }) => {
			const id = session?.id;
			if (event?.type !== "compaction/start" || typeof id !== "string") {
				return;
			}
			const slot = slots.get(id);
			if (slot === undefined || slot.pending === null) {
				return;
			}
			drain(id, "compaction");
		}),
	);
	listeners.push(
		host.on("agent/disposed", (payload: { agent?: unknown }) => {
			const id = (payload.agent as { id?: unknown } | undefined)?.id;
			if (typeof id !== "string") {
				return;
			}
			const slot = slots.get(id);
			if (slot === undefined) {
				return;
			}
			if (slot.pending !== null) {
				drain(id, "close-drain");
			}
			// The session is gone: drop its slot. A run already in flight holds
			// its own reference and simply finds nothing left to drain.
			slots.delete(id);
		}),
	);
	host.log.info("extraction-armed", "scheduler armed (per-session slots, turn-level, single-flight per session)");
	return () => {
		slots.clear();
		for (const listener of listeners) {
			if (typeof listener === "function") {
				listener();
			}
		}
	};
}
