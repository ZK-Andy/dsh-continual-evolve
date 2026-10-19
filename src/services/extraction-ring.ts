/**
 * The extraction pass, assembled as a responsibility chain: cheap pre-gate →
 * classification prior (P2 two-stage) → proposal call (and, on a proposal,
 * the store's gated application).
 *
 * The gate fails open by design — an unclear or dead gate hands the increment
 * to the expensive call, so the worst case is the old single-call behavior,
 * never a stall. Classification follows the same discipline: a dead classify
 * hands the increment to the generation call without a prior. Only a
 * *verdict-level* empty classification short-circuits (zero generation
 * tokens). Every link ledgers everything it observes onto the run's own
 * row: one run stays one row, and a failed call keeps the usage and route it
 * reported before it died.
 */
import { runChain, type ChainLink, type ChainOutcome } from "./chain.js";
import { observedUsageOf } from "./llm-call.js";
import type { ModelSelection } from "./model-route.js";
import { boundaryCursorOf, eventsAfterCursor, evaluateSlice, seqOfCursor, serializeIncrement } from "./extraction-surface.js";
import { CHEAP_INCREMENT_MAX, cheapPrompt, classifyPrompt } from "./extraction-prompt.js";
import { todayUtc } from "./prompt-date.js";
import { extractionClassify, extractionGate } from "./subagent-defs.js";
import { cutFailureOf, subagentLoaderFor, type SubagentCall } from "./subagent.js";
import type { ExtractionDeps, ExtractionResult, ExtractionTarget, RunOptions } from "./extraction.js";
import { errorText, runIdOf, type ExtractionItem } from "./extraction-item.js";
import { proposeLink } from "./extraction-propose.js";

/** Head length of an error message embedded in a ledger `skip_reason`. */
export const ERROR_REASON_MAX = 300;

/** Head length of a failed pre-gate call's error kept in the ledger `cheap_error` column. */
const GATE_ERROR_MAX = 200;

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
		classify: undefined,
		classifyUsage: undefined,
		classifyError: undefined,
		classifyPromptText: undefined,
	};
	await runChain(extractionChain(), item);
	if (item.result === undefined) {
		// Unreachable while the main link always handles the item; kept so a
		// future chain edit cannot silently return "nothing happened".
		throw new Error("extraction chain ended without a result");
	}
	return item.result;
}

/** Assemble the extraction chain: pre-gate (fail open) → classify (fail open) → proposal call. */
function extractionChain(): readonly ChainLink<ExtractionItem>[] {
	return [gateLink(), classifyLink(), proposeLink()];
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
						runId: runIdOf(item),
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

/**
 * Classification prior (P2 two-stage): classify only, never write. A
 * verdict-level empty `worthy` short-circuits the run (no generation call,
 * cursor advances, zero generation tokens); a transport-level failure
 * (throw/cut/unparseable) fails OPEN to the generation call without a prior
 * — the verdict gate must never turn a transient fault into a lost memory.
 */
function classifyLink(): ChainLink<ExtractionItem> {
	return {
		name: "extraction-classify",
		async handle(item: ExtractionItem): Promise<ChainOutcome> {
			const classifyStarted = Date.now();
			const classifyPromptText = classifyPrompt({
				incrementHead: item.increment.slice(0, CHEAP_INCREMENT_MAX),
				userSeqs: item.userSeqs,
			});
			item.classifyPromptText = classifyPromptText;
			try {
				const answer = await item.loader.run(extractionClassify, classifyPromptText);
				item.classifyUsage = answer.usage;
				const result = answer.answer;
				if (result === null && answer.finish !== undefined && answer.finish !== "stop") {
					throw cutFailureOf(answer, item.route);
				}
				if (result === null) {
					item.classifyError = "classify-unparseable";
					return "next";
				}
				if (result.worthy.length === 0) {
					item.advanceCursor();
					item.deps.store.logSkipped({
						...item.ledgerBase,
						runId: runIdOf(item),
						skipReason: `model-skip (classify-none): ${result.reason}`,
						status: "skipped",
						model: item.route.model,
						cheapUsage: item.cheapUsage,
						cheapError: item.cheapError,
						classifyUsage: item.classifyUsage,
						durationMs: Date.now() - classifyStarted,
					});
					item.result = { status: "skipped", skipReason: result.reason, cursor: item.boundarySeq };
					return "handled";
				}
				item.classify = result;
			} catch (error) {
				item.classifyError = errorHead(error);
				item.classifyUsage = observedUsageOf(error) ?? item.classifyUsage;
			}
			return "next";
		},
	};
}

/** One-line head of a thrown pre-gate error (flat, so the column stays greppable). */
function errorHead(error: unknown): string {
	return errorText(error).message.replace(/\s+/g, " ").trim().slice(0, GATE_ERROR_MAX);
}
