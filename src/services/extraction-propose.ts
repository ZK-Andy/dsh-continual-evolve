/**
 * The extraction proposal phase: the run's one expensive call, then the
 * store's gates.
 *
 * It lives apart from the chain so the ring keeps one edge for the proposal
 * phase and this module stays the single home of the prompt-audit wiring
 * (`prompt_json`, `dropped_warnings`). The ring owns the entry, the chain
 * assembly, and the two priors (cheap gate, classification); this module
 * owns everything from the generation prompt down to the applied/rejected
 * ledger row.
 */
import type { ChainLink, ChainOutcome } from "./chain.js";
import { failureCodeOf, isRouteRejected, observedUsageOf } from "./llm-call.js";
import { screenExtractionBatch } from "./extraction-screen.js";
import { buildPromptJson, extractionPrompt, formatClassification, manifestLineOf, type ParsedAnswer } from "./extraction-prompt.js";
import { pruneIfDue } from "./retention.js";
import { cutFailureOf, type SubagentAnswer } from "./subagent.js";
import { extractionMain } from "./subagent-defs.js";
import { ROUTE_REJECTED_REASON, type MemoryStore } from "../store.js";
import { errorText, runIdOf, type ExtractionItem } from "./extraction-ring.js";

/** Head length of a failed run's raw answer kept in the ledger `files` column. */
const FAILURE_RAW_MAX = 2048;

/** The prompts JSON for one run's ledger row. */
function promptJsonOf(item: ExtractionItem, prompt: string): string {
	const input: { classifyPrompt?: string; prompt: string } =
		item.classifyPromptText === undefined ? { prompt } : { classifyPrompt: item.classifyPromptText, prompt };
	return buildPromptJson(input);
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
		classification: item.classify === undefined ? undefined : formatClassification(item.classify),
	});
}

/** The proposal call: the run's one expensive call, then the store's gates. */
export function proposeLink(): ChainLink<ExtractionItem> {
	return {
		name: "extraction-propose",
		async handle(item: ExtractionItem): Promise<ChainOutcome> {
			const prompt = buildExtractionPrompt(item);
			const started = Date.now();
			const answer = await runProposalCall(item, prompt, started);
			if (answer === undefined) {
				return "handled";
			}
			return settleProposalAnswer(item, answer, prompt, started);
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
		// A refused route is labelled as such in the account: the failure
		// discipline's halt is only visible if the row says why it happened.
		const reason = isRouteRejected(error) ? ROUTE_REJECTED_REASON : "llm-failed";
		try {
			store.logSkipped({
				...item.ledgerBase,
				runId: runIdOf(item),
				skipReason: reason,
				status: "failed",
				model: item.route.model,
				usage: observedUsageOf(error),
				durationMs: Date.now() - started,
				cheapUsage: item.cheapUsage,
				cheapError: item.cheapError,
				classifyUsage: item.classifyUsage,
				classifyError: item.classifyError,
				promptJson: promptJsonOf(item, prompt),
				files: detail,
			});
		} catch (ledgerError) {
			throw new Error(`llm call failed (${message}); failure ledger write also failed (${errorText(ledgerError).message})`);
		}
		item.result = {
			status: "failed",
			skipReason: reason === ROUTE_REJECTED_REASON ? ROUTE_REJECTED_REASON : `llm call failed: ${message}`,
			faultCode: failureCodeOf(error),
		};
		return undefined;
	}
}

/** Settle a completed call: error answers fail, skips advance the cursor, proposals apply. */
function settleProposalAnswer(
	item: ExtractionItem,
	answer: SubagentAnswer<ParsedAnswer>,
	prompt: string,
	started: number,
): ChainOutcome {
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
			runId: runIdOf(item),
			skipReason: parsed.reason,
			status: "failed",
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			classifyUsage: item.classifyUsage,
			classifyError: item.classifyError,
			promptJson: promptJsonOf(item, prompt),
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
			runId: runIdOf(item),
			skipReason: `model-skip: ${parsed.reason}`,
			status: "skipped",
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			classifyUsage: item.classifyUsage,
			classifyError: item.classifyError,
			durationMs: Date.now() - started,
		});
		item.result = { status: "skipped", skipReason: parsed.reason, cursor: item.boundarySeq };
		return "handled";
	}
	return applyProposalAnswer(item, parsed, prompt, usage);
}

/** Apply an apply-decision answer through the store gates, with hygiene riding along. */
function applyProposalAnswer(item: ExtractionItem, parsed: ParsedAnswer, prompt: string, usage: unknown): ChainOutcome {
	// The store's own proposal shape — no second import for a type the gate owns.
	type MemoryProposal = Parameters<MemoryStore["applyProposals"]>[1][number];
	const { store } = item.deps;
	// Deterministic pre-screen (P2: identity gate first, then duplicate/no-change):
	// forged ids and collisions never reach the write gate, so one bad proposal
	// no longer kills the batch — it lands in `dropped_warnings` instead.
	const screened = screenExtractionBatch(store, item.ledgerBase.workspaceId, parsed.proposals as MemoryProposal[]);
	const runId = runIdOf(item);
	const dropped = screened.warnings.length > 0 ? screened.warnings : undefined;
	if (screened.kept.length === 0) {
		item.advanceCursor();
		const reason = screened.skipReason ?? "pre-screen: no proposals";
		store.logSkipped({
			...item.ledgerBase,
			runId,
			skipReason: reason,
			status: "skipped",
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			classifyUsage: item.classifyUsage,
			classifyError: item.classifyError,
			droppedWarnings: dropped,
		});
		item.result = { status: "skipped", skipReason: reason, cursor: item.boundarySeq };
		return "handled";
	}
	const outcomes = store.applyProposals(
		{
			workspaceId: item.ledgerBase.workspaceId,
			trigger: item.opts.trigger,
			sessionId: item.target.sessionId,
			runId,
			model: item.route.model,
			usage,
			cheapUsage: item.cheapUsage,
			cheapError: item.cheapError,
			classifyUsage: item.classifyUsage,
			classifyError: item.classifyError,
			promptJson: promptJsonOf(item, prompt),
			droppedWarnings: dropped,
			decision: parsed.reason,
		},
		screened.kept,
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
