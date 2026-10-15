/**
 * The extraction pass, assembled as a responsibility chain: cheap pre-gate →
 * proposal call (and, on a proposal, the store's gated application).
 *
 * The gate fails open by design — an unclear or dead gate hands the increment
 * to the expensive call, so the worst case is the old single-call behavior,
 * never a stall. Both links ledger everything they observe onto the run's own
 * row: one run stays one row, and a failed call keeps the usage and route it
 * reported before it died.
 */
import { runChain, type ChainLink, type ChainOutcome } from "./chain.js";
import { observedUsageOf, type ModelSelection } from "./llm-call.js";
import { boundaryCursorOf, eventsAfterCursor, evaluateSlice, seqOfCursor, serializeIncrement } from "./extraction-surface.js";
import { CHEAP_INCREMENT_MAX, cheapPrompt, extractionPrompt, manifestLineOf, type ParsedAnswer } from "./extraction-prompt.js";
import { todayUtc } from "./prompt-date.js";
import { pruneIfDue } from "./retention.js";
import { extractionGate, extractionMain } from "./subagent-defs.js";
import { cutFailureOf, subagentLoaderFor, type SubagentAnswer, type SubagentCall, type SubagentLoader } from "./subagent.js";
import type { LedgerEntry, MemoryStore } from "./store.js";
import type { ExtractionDeps, ExtractionResult, ExtractionTarget, RunOptions } from "./extraction.js";
import type { MemoryProposal } from "./services/memory-rules.js";

/** Head length of a failed run's raw answer kept in the ledger `files` column. */
const FAILURE_RAW_MAX = 2048;

/** Head length of an unexpected error's message/stack trace kept in the ledger `files` column. */
const UNEXPECTED_ERROR_RAW_MAX = 2048;

/** Head length of an error message embedded in a ledger `skip_reason`. */
export const ERROR_REASON_MAX = 300;

/** Head length of a failed pre-gate call's error kept in the ledger `cheap_error` column. */
const GATE_ERROR_MAX = 200;

/** One run's walk through the chain: the context both links read and fill in. */
interface ExtractionItem {
	readonly deps: ExtractionDeps;
	readonly target: ExtractionTarget;
	readonly opts: RunOptions;
	readonly ledgerBase: { sessionId: string; workspaceId: string; trigger: LedgerEntry["trigger"] };
	readonly route: ModelSelection;
	readonly loader: SubagentLoader;
	readonly increment: string;
	readonly userSeqs: readonly number[];
	readonly userText: string;
	readonly boundarySeq: number | undefined;
	readonly advanceCursor: () => void;
	/** The pre-gate's observed usage, carried onto the run's own row. */
	cheapUsage: unknown;
	/** Why the pre-gate left no payload (fail open); `undefined` when it never ran or answered. */
	cheapError: string | undefined;
	/** The terminal outcome, set by the link that handles the item. */
	result?: ExtractionResult;
}

/**
 * The pipeline body: one bounded increment of one session, one LLM call, one
 * gated transactional application, one ledger row, one cursor.
 *
 * @param deps - The store, the trajectory reader, and the LLM.
 * @param target - Whose session, in which workspace, on which route.
 * @param opts - The trigger and the increment ceiling.
 * @returns The terminal outcome of the run.
 * @throws Only when the ledger itself is unwritable (the caller ledgers that too).
 */
export async function runExtractionInner(deps: ExtractionDeps, target: ExtractionTarget, opts: RunOptions): Promise<ExtractionResult> {
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
	// Narrowed once, here: the loader takes one concrete route and session.
	const workspaceId: string = target.workspaceId;
	const route: ModelSelection = { provider: target.provider, model: target.model };
	const call: SubagentCall = { llm: deps.llm, route, sessionId: target.sessionId, today: opts.today ?? todayUtc() };

	const cursor = store.cursor(workspaceId, target.sessionId);
	let all: readonly unknown[];
	try {
		const snapshot = await deps.surface.readSurface(target.sessionId);
		all = Array.isArray(snapshot.events) ? snapshot.events : [];
	} catch (error) {
		const { message, detail } = errorText(error);
		try {
			store.logSkipped({ ...ledgerBase, skipReason: "surface-read-failed", status: "failed", files: detail });
		} catch (ledgerError) {
			throw new Error(`surface read failed (${message}); failure ledger write also failed (${errorText(ledgerError).message})`);
		}
		return { status: "failed", skipReason: `surface read failed: ${message}` };
	}
	const events = eventsAfterCursor(all, cursor === undefined ? undefined : `seq:${cursor}`);
	const slice = evaluateSlice({ events, internalAgent: false });
	if (!slice.eligible) {
		store.logSkipped({ ...ledgerBase, skipReason: slice.skipReason, status: "skipped" });
		return { status: "skipped", skipReason: slice.skipReason };
	}

	const boundary = boundaryCursorOf(all);
	const boundarySeq = seqOfCursor(boundary);
	const item: ExtractionItem = {
		deps,
		target,
		opts,
		ledgerBase: { ...ledgerBase, workspaceId },
		route,
		loader: subagentLoaderFor(call),
		increment: serializeIncrement(slice.events, opts.incrementMaxChars),
		userSeqs: slice.userSeqs,
		userText: slice.userText,
		boundarySeq,
		advanceCursor: () => {
			if (boundarySeq !== undefined) {
				store.setCursor(workspaceId, target.sessionId, boundarySeq);
			}
		},
		cheapUsage: undefined,
		cheapError: undefined,
	};
	await runChain(extractionChain(), item);
	if (item.result === undefined) {
		// Unreachable while the main link always handles the item; kept so a
		// future chain edit cannot silently return "nothing happened".
		throw new Error("extraction chain ended without a result");
	}
	return item.result;
}

/** Assemble the extraction chain: the pre-gate (fail open) then the proposal call. */
function extractionChain(): readonly ChainLink<ExtractionItem>[] {
	return [gateLink(), proposeLink()];
}

/**
 * Cheap pre-gate: a small verdict before the expensive full call (manifest +
 * full-body candidates + full increment). A "not worth it" consumes the
 * increment exactly like a model skip; an unclear gate (unparseable/failed)
 * fails OPEN to the full call. A gate that dies still rides the run's own row
 * as `cheap_error` — without it a failed gate is indistinguishable from a gate
 * that never existed, which is how a 512-token budget truncating every call on
 * a reasoning model stayed invisible — and now its observed usage rides the
 * same row.
 */
function gateLink(): ChainLink<ExtractionItem> {
	return {
		name: "extraction-gate",
		async handle(item: ExtractionItem): Promise<ChainOutcome> {
			const gateStarted = Date.now();
			try {
				const answer = await item.loader.run(extractionGate, cheapPrompt({
					incrementHead: item.increment.slice(0, CHEAP_INCREMENT_MAX),
					userSeqs: item.userSeqs,
				}));
				item.cheapUsage = answer.usage;
				const verdict = answer.answer;
				// A gate cut at its budget that still answered is a usable verdict;
				// only a cut with nothing parseable rides the run's row as a gate
				// error. Parse before blaming the finish reason.
				if (verdict === null && answer.finish !== undefined && answer.finish !== "stop") {
					throw cutFailureOf(answer, item.route);
				}
				if (verdict !== null && !verdict.worth) {
					item.advanceCursor();
					item.deps.store.logSkipped({
						...item.ledgerBase,
						skipReason: `model-skip (cheap-gate): ${verdict.reason}`,
						status: "skipped",
						model: item.route.model,
						cheapUsage: item.cheapUsage,
						durationMs: Date.now() - gateStarted,
					});
					item.result = { status: "skipped", skipReason: verdict.reason, cursor: item.boundarySeq };
					return "handled";
				}
			} catch (error) {
				// Fail open: the proposal call below is the old behavior. The error
				// head is kept for the run's own row (never a row of its own, so
				// one run stays one ledger row), and whatever the call reported
				// before it died is kept with it.
				item.cheapError = errorHead(error);
				item.cheapUsage = observedUsageOf(error) ?? item.cheapUsage;
			}
			return "next";
		},
	};
}

/** Assemble the proposal prompt: manifest plus similar-record candidates. */
function buildExtractionPrompt(item: ExtractionItem): string {
	const { store } = item.deps;
	const workspaceId = item.ledgerBase.workspaceId;
	const manifest = store.list(workspaceId).slice(0, 50).map(manifestLineOf);
	const candidates = candidateRecords(store, workspaceId, item.userText);
	return extractionPrompt({
		increment: item.increment,
		manifest,
		candidates: candidates.map(formatCandidate),
		userSeqs: item.userSeqs,
	});
}

/** The proposal call: the run's one expensive call, then the store's gates. */
function proposeLink(): ChainLink<ExtractionItem> {
	return {
		name: "extraction-propose",
		async handle(item: ExtractionItem): Promise<ChainOutcome> {
			const prompt = buildExtractionPrompt(item);
			const started = Date.now();
			const answer = await runProposalCall(item, prompt, started);
			if (answer === undefined) {
				return "handled";
			}
			return settleProposalAnswer(item, answer, started);
		},
	};
}

/** Run the one expensive call; an llm failure is ledgered here and reads as handled. */
async function runProposalCall(
	item: ExtractionItem,
	prompt: string,
	started: number,
): Promise<SubagentAnswer<ParsedAnswer> | undefined> {
	const { store } = item.deps;
	try {
		const answer = await item.loader.run(extractionMain, prompt);
		// The full call carries the proposal payload: a cut stream is a failure.
		if (answer.finish !== undefined && answer.finish !== "stop") {
			throw cutFailureOf(answer, item.route);
		}
		return answer;
	} catch (error) {
		const { message, detail } = errorText(error);
		try {
			store.logSkipped({
				...item.ledgerBase,
				skipReason: "llm-failed",
				status: "failed",
				model: item.route.model,
				usage: observedUsageOf(error),
				durationMs: Date.now() - started,
				cheapUsage: item.cheapUsage,
				cheapError: item.cheapError,
				files: detail,
			});
		} catch (ledgerError) {
			throw new Error(`llm call failed (${message}); failure ledger write also failed (${errorText(ledgerError).message})`);
		}
		item.result = { status: "failed", skipReason: `llm call failed: ${message}` };
		return undefined;
	}
}
/** Settle a completed call: error answers fail, skips advance the cursor, proposals apply. */
function settleProposalAnswer(item: ExtractionItem, answer: SubagentAnswer<ParsedAnswer>, started: number): ChainOutcome {
	const { store } = item.deps;
	const text = answer.text;
	const usage = answer.usage;
	const parsed = answer.answer;
	if (parsed.decision === "error") {
		// A malformed answer is a failed run: the increment stays unconsumed
		// and the next trigger retries it. The answer's head rides in the
		// ledger row — the stream is gone after this, so without it the
		// failure is undiagnosable after the fact.
		store.logSkipped({
			...item.ledgerBase,
			skipReason: parsed.reason,
			status: "failed",
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			durationMs: Date.now() - started,
			files: text.slice(0, FAILURE_RAW_MAX),
		});
		item.result = { status: "failed", skipReason: parsed.reason };
		return "handled";
	}
	if (parsed.decision === "skip") {
		// A real model decision (even "nothing worth keeping") consumed the
		// increment — advancing the cursor here is what keeps retries honest.
		item.advanceCursor();
		store.logSkipped({
			...item.ledgerBase,
			skipReason: `model-skip: ${parsed.reason}`,
			status: "skipped",
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			durationMs: Date.now() - started,
		});
		item.result = { status: "skipped", skipReason: parsed.reason, cursor: item.boundarySeq };
		return "handled";
	}
	return applyProposalAnswer(item, parsed, usage);
}

/** Apply an apply-decision answer through the store gates, with hygiene riding along. */
function applyProposalAnswer(item: ExtractionItem, parsed: ParsedAnswer, usage: unknown): ChainOutcome {
	const { store } = item.deps;
	const outcomes = store.applyProposals(
		{
			workspaceId: item.ledgerBase.workspaceId,
			trigger: item.opts.trigger,
			sessionId: item.target.sessionId,
			runId: `extract:${item.target.sessionId}:${item.boundarySeq ?? "tail"}`,
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			decision: parsed.reason,
		},
		parsed.proposals as MemoryProposal[],
	);
	if (!outcomes.every((outcome) => outcome.ok)) {
		item.result = { status: "rejected", skipReason: outcomes.find((outcome) => !outcome.ok)?.reason };
		return "handled";
	}
	item.advanceCursor();
	// Hygiene rides on every applied run: orphan FTS rows dropped, secret
	// leakage quarantined — never a separate scheduler.
	const patrol = store.patrol();
	void patrol;
	// Retention rides the same run: the ledgers only grow, and an
	// applied extraction is what writes most of their rows. Day-throttled
	// inside, so this is one state read on all but the day's first run.
	pruneIfDue(store);
	item.result = { status: "applied", applied: outcomes.filter((outcome) => outcome.ok).length, cursor: item.boundarySeq };
	return "handled";
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

/** Split an unexpected throw into a ledger-sized reason head and file body. */
export function errorText(error: unknown): { message: string; detail: string } {
	const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
	const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : message;
	return { message, detail: `${message}\n${stack}`.slice(0, UNEXPECTED_ERROR_RAW_MAX) };
}

/** One-line head of a thrown pre-gate error (flat, so the column stays greppable). */
function errorHead(error: unknown): string {
	return errorText(error).message.replace(/\s+/g, " ").trim().slice(0, GATE_ERROR_MAX);
}
