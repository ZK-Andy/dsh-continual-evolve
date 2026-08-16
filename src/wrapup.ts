/**
 * Session wrap-up: the lifecycle exit for a session's local harness entries.
 *
 * When a session ends, its local entries default to orphans: a later session
 * (not on the parentSession chain) never sees them, and nothing promotes or
 * archives them — the exploration results effectively "die" with the session.
 * Wrap-up gives those entries a real exit:
 *
 * - cross-session-reusable content is classified `promote` and moved into the
 *   global store (through the human approval gate — global is a governed
 *   resource, exactly like skill proposals);
 * - session-specific / superseded / already-covered content is classified
 *   `archive` (hidden from injection, data stays restorable, rollbackable);
 * - everything else is kept.
 *
 * Division of labor is deliberate: the mechanical audit proposes, the LLM
 * classifies, the user approves, the code applies deterministically. The
 * apply-side guard (`filterPromotable`) re-checks global coverage at apply
 * time so a stale classification can never write a duplicate global entry.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessEntry, HarnessState, RefinementKind } from "./types.js";
import { PROMOTED_TO_KEY, isArchived } from "./types.js";
import { extractJsonObject } from "./plan.js";
import { compactText } from "./render.js";

/** What should happen to one local entry at session end. */
export type WrapupVerdict = "promote" | "archive" | "keep";

/** A classified local entry: `key` matches one audited candidate exactly. */
export interface WrapupItem {
	/** `kind:id` of the candidate this verdict refers to. */
	key: string;
	verdict: WrapupVerdict;
	reason: string;
}

/** The model's full classification of a session's local entries. */
export interface WrapupAssessment {
	items: WrapupItem[];
	rationale: string;
}

/** A local entry offered for assessment, plus its deterministic audit flags. */
export interface WrapupCandidate {
	kind: RefinementKind;
	id: string;
	title: string;
	content: string;
	path: string;
	version: number;
	metadata: Record<string, unknown>;
	/** True when the global store already covers this topic (same id or near-identical title). */
	coveredGlobally: boolean;
}

export function candidateKey(kind: RefinementKind, id: string): string {
	return `${kind}:${id}`;
}

/** Lowercase, punctuation-stripped title used for cheap coverage matching. */
function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "").trim();
}

/**
 * Deterministic global-coverage check: the global store already covers a
 * topic when it holds the same entry id, or a title that normalizes equal to,
 * or (beyond a length floor) contains, the candidate's normalized title.
 * Archived global entries count too — the topic was already judged
 * cross-session; a local duplicate would only re-sediment it.
 */
export function globalCoverageDetected(
	globalState: HarnessState,
	kind: RefinementKind,
	entry: Pick<HarnessEntry, "id" | "title">,
): boolean {
	const records = globalState.entries[kind];
	if (records[entry.id]) return true;
	const title = normalizeKey(entry.title);
	if (title.length === 0) return false;
	for (const other of Object.values(records)) {
		const otherTitle = normalizeKey(other.title);
		if (otherTitle.length === 0) continue;
		if (otherTitle === title) return true;
		if (title.length >= 4 && otherTitle.length >= 4 && (title.includes(otherTitle) || otherTitle.includes(title))) {
			return true;
		}
	}
	return false;
}

/**
 * The auditable local candidates of a session: every non-archived local
 * entry that has not already been promoted (a promoted entry's lifecycle is
 * finished — the global copy is the live one). Each carries its
 * `coveredGlobally` flag so the assessor never wastes a promote on a topic
 * the global store already owns.
 */
export function listLocalCandidates(state: HarnessState, globalState: HarnessState): WrapupCandidate[] {
	const candidates: WrapupCandidate[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		for (const entry of Object.values(state.entries[kind])) {
			if (entry.scope !== "local") continue;
			if (isArchived(entry)) continue;
			if (typeof entry.metadata[PROMOTED_TO_KEY] === "string") continue;
			candidates.push({
				kind,
				id: entry.id,
				title: entry.title,
				content: entry.content,
				path: entry.path,
				version: entry.version,
				metadata: entry.metadata,
				coveredGlobally: globalCoverageDetected(globalState, kind, entry),
			});
		}
	}
	return candidates;
}

/**
 * Parse and validate the model's assessment JSON. Defense is mechanical:
 * keys outside the candidate list are dropped, verdicts outside the enum
 * collapse to "keep", and candidates the model omitted default to "keep" —
 * a malformed reply can never change an entry's fate by itself.
 */
export function parseWrapupAssessment(text: string, candidates: readonly WrapupCandidate[]): WrapupAssessment {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("wrap-up assessment JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(candidates.map((candidate) => candidateKey(candidate.kind, candidate.id)));
	const items: WrapupItem[] = [];
	if (Array.isArray(record["items"])) {
		for (const raw of record["items"]) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Record<string, unknown>;
			const key = typeof item["key"] === "string" ? item["key"] : "";
			if (!allowed.has(key)) continue;
			const verdict = item["verdict"] === "promote" || item["verdict"] === "archive" ? item["verdict"] : "keep";
			items.push({ key, verdict, reason: typeof item["reason"] === "string" ? item["reason"] : "" });
		}
	}
	for (const candidate of candidates) {
		const key = candidateKey(candidate.kind, candidate.id);
		if (!items.some((item) => item.key === key)) {
			items.push({ key, verdict: "keep", reason: "not mentioned by the assessor" });
		}
	}
	return { items, rationale: typeof record["rationale"] === "string" ? record["rationale"] : "" };
}

export interface PromotableSplit {
	/** Items that may be promoted: classified promote AND not covered globally. */
	promotable: WrapupItem[];
	/** Items classified promote but blocked by the deterministic guard, with why. */
	skipped: { key: string; reason: string }[];
}

/**
 * Apply-time deterministic guard: re-check every promote verdict against the
 * global store right before it lands. The LLM classification may be stale
 * (a gate ran while assessing) or wrong; this ensures a promote never writes
 * a duplicate global entry. Pure and unit-tested.
 */
export function filterPromotable(
	items: readonly WrapupItem[],
	globalState: HarnessState,
	candidates: readonly WrapupCandidate[],
): PromotableSplit {
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const promotable: WrapupItem[] = [];
	const skipped: { key: string; reason: string }[] = [];
	for (const item of items) {
		if (item.verdict !== "promote") continue;
		const candidate = byKey.get(item.key);
		if (!candidate) {
			skipped.push({ key: item.key, reason: "not in the audited candidate list" });
			continue;
		}
		if (candidate.coveredGlobally || globalCoverageDetected(globalState, candidate.kind, candidate)) {
			skipped.push({ key: item.key, reason: "already covered globally" });
			continue;
		}
		promotable.push(item);
	}
	return { promotable, skipped };
}

export const WRAPUP_ASSESS_SYSTEM_PROMPT = `You are the /evolve session wrap-up assessor.

A session is ending and its local harness entries need a fate. Classify each
listed entry exactly once:

- "promote" — the content is a stable, durable, CROSS-SESSION reusable lesson:
  a durable user preference, a project-level fact or convention, a reusable
  procedure or skill. Future sessions would benefit from seeing it.
- "archive" — the content is session-specific task progress, one-off noise,
  superseded or obsolete, or already covered by the global store (note
  "covered globally" in the reason).
- "keep" — still actively useful to this session, or genuinely uncertain.

Rules:
- When an entry is marked "covered globally", prefer "archive" or "keep" over
  "promote" — promoting a duplicate gains nothing.
- Do not promote local task state, work-in-progress notes, or content tied to
  one session's ephemeral details.
- Skills: only "promote" a skill entry that is a genuinely reusable procedure
  meeting the DSH skill quality standard; one-off workflows are "archive" or
  "keep".

Return JSON only:
{
  "rationale": "one or two sentences",
  "items": [
    {"key": "memory:foo", "verdict": "promote|archive|keep", "reason": "why"}
  ]
}
Only keys from the provided list are allowed; any entry you omit defaults to "keep".`;

export interface AssessOptions {
	/** Output token budget for the assessment call. */
	maxOutputTokens?: number;
	/** Abort signal forwarded to the model call. */
	signal?: AbortSignal;
}

/**
 * Ask the model to classify the audited local candidates. Routes through the
 * calling agent's own provider/model (same model the session runs on), with
 * reasoning disabled so the output budget goes to the JSON verdicts.
 */
export async function assessLocalEntries(
	ctx: Context,
	agent: Agent,
	candidates: readonly WrapupCandidate[],
	options: AssessOptions = {},
): Promise<WrapupAssessment> {
	if (candidates.length === 0) {
		return { items: [], rationale: "No local candidates to assess." };
	}
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: no provider/model route for the wrap-up assessor");
	}
	const candidateText = candidates
		.map((candidate) => {
			const key = candidateKey(candidate.kind, candidate.id);
			const covered = candidate.coveredGlobally ? " (covered globally)" : "";
			return `- ${key} [${candidate.path}, v${candidate.version}] "${candidate.title}"${covered}: ${compactText(candidate.content, 220)}`;
		})
		.join("\n");
	const userPrompt = [
		`A local session is wrapping up. Classify each entry below for its fate.`,
		`<local_entries>\n${candidateText}\n</local_entries>`,
		"Return only JSON. Every item must reference one of the keys above.",
	].join("\n\n");

	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream({
		provider: agent.options.provider,
		model: agent.options.model,
		system: WRAPUP_ASSESS_SYSTEM_PROMPT,
		messages: [
			createUserMessage({
				content: [{ type: "text", text: userPrompt }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
			}),
		],
		// Force non-reasoning output so the budget lands in the JSON verdicts.
		reasoningEffort: ReasoningEffortId("off"),
		maxTokens: options.maxOutputTokens ?? 4096,
		...(options.signal ? { signal: options.signal } : {}),
	})) {
		assembler.push(chunk);
	}
	const finish = assembler.finish;
	if (finish.kind === "error") {
		throw new Error(`evolve: wrap-up assessor call failed: ${(finish as { failure?: { message?: string } }).failure?.message ?? "unknown"}`);
	}
	if (finish.kind === "aborted") {
		throw new Error("evolve: wrap-up assessor call aborted");
	}
	if (finish.kind === "max-tokens") {
		throw new Error("evolve: wrap-up assessor output budget exhausted (max-tokens)");
	}
	const text = assembler
		.blocks()
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length === 0) {
		throw new Error("evolve: wrap-up assessor produced no text");
	}
	return parseWrapupAssessment(text, candidates);
}
