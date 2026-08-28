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
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessEntry, HarnessState, RefinementKind, RefinementProposal } from "./types.js";
import { ARCHIVED_AT_KEY, PROMOTED_AT_KEY, PROMOTED_TO_KEY, SOURCE_SEQS_KEY, SOURCE_SESSION_KEY, SOURCED_FROM_KEY, VALENCE_NEGATIVE_KEY, isArchived } from "./types.js";
import { extractJsonObject } from "./plan.js";
import { compactText } from "./render.js";
import { streamText } from "./llm-text.js";
import { getUsageCount, loadUsage } from "./usage.js";
import { recencyScore } from "./inject.js";
import { DEFAULT_PROMOTION_POLICY, mostSimilarGlobalEntry, projectScopedReason, secretLeakReason, type PromotionPolicy } from "./promotion.js";

/** What should happen to one local entry at session end. */
export type WrapupVerdict = "promote" | "archive" | "keep";

/** A classified local entry: `key` matches one audited candidate exactly. */
export interface WrapupItem {
	/** `kind:id` of the candidate this verdict refers to. */
	key: string;
	verdict: WrapupVerdict;
	reason: string;
	/**
	 * Optional split-promotion payload (verdict "archive" only): the entry is
	 * archived as a whole, but a CLEANED cross-session-reusable part is
	 * offered for promotion — the durable fact distilled out of the mixed
	 * entry, with the ephemeral snapshot left behind in the archive.
	 */
	promote?: {
		title: string;
		content: string;
	};
	/**
	 * Valence signal (P1 效价反馈): the assessor found trajectory or global
	 * evidence contradicting this entry's content (user correction, overridden
	 * fact). Strictly parsed — only an explicit JSON `true` sets it. Keep
	 * verdicts with this flag get a negative-valence stamp; the assessor is
	 * instructed to prefer "archive" for contradicted entries.
	 */
	contradicted?: boolean;
}

/** A real global entry worth showing the assessor for the same topic. */
export interface GlobalHint {
	id: string;
	title: string;
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
	/**
	 * True when the global store already covers this topic by a STRONG
	 * signal: a title that normalizes equal to, or (beyond a length floor)
	 * contains, the candidate's title. Collisions on id alone with a wildly
	 * different title are deliberately NOT coverage — see {@link globalHintsFor}.
	 */
	coveredGlobally: boolean;
	/**
	 * Actual global entries that touch the same topic (same id, equal
	 * normalized title, or title overlap). Shown to the assessor so it judges
	 * against real titles instead of a bare boolean; a bare same-id collision
	 * shows up here precisely so the model can tell whether the global copy
	 * really covers the local content.
	 */
	globalHints: GlobalHint[];
	/**
	 * Injection usage count (gap B1): how many times this entry was included
	 * in a system-prompt assembly. Zero means the entry was never used — a
	 * strong staleness signal the assessor can weigh.
	 */
	injectionCount: number;
	/**
	 * Staleness flag (gap B2): true when the entry has both zero injection
	 * usage AND a recency score below the staleness threshold (old + unused).
	 * The assessor is instructed to prefer "archive" for stale entries.
	 */
	stale: boolean;
	/**
	 * Negative-valence counter (P1 效价反馈): how many prior assessments marked
	 * this entry contradicted (metadata {@link VALENCE_NEGATIVE_KEY}). Shown to
	 * the assessor so it can prefer "archive"; also demotes the entry in
	 * injection ranking (inject.ts rankEntries).
	 */
	negativeCount: number;
}

export function candidateKey(kind: RefinementKind, id: string): string {
	return `${kind}:${id}`;
}

/** Lowercase, punctuation-stripped title used for cheap coverage matching. */
function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "").trim();
}

/**
 * Deterministic global-coverage check (STRONG signal): the global store
 * already covers a topic when it holds a title that normalizes equal to, or
 * (beyond a length floor) contains, the candidate's normalized title.
 * Archived global entries count too — the topic was already judged
 * cross-session; a local duplicate would only re-sediment it.
 *
 * The bare same-id case is deliberately NOT coverage: ids are slugs derived
 * from titles, so a real collision is usually caught by the title check
 * below. A same-id entry with a wildly different title is a weak signal — the
 * caller routes it through {@link globalHintsFor} for the assessor to judge
 * against the actual global title (real case: local `memory` "用户产品愿景与
 * 收入需求（本会话）" vs global `memory` "用户画像（持续更新）").
 */
export function globalCoverageDetected(
	globalState: HarnessState,
	kind: RefinementKind,
	entry: Pick<HarnessEntry, "id" | "title">,
): boolean {
	const records = globalState.entries[kind];
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
 * The actual global entries that touch the same topic as a local candidate:
 * same id (regardless of title — the weak collision signal that is NOT
 * coverage on its own), equal normalized title, or title overlap. The raw ids
 * and titles let the assessor judge enrichment against real global content
 * (does the global copy already hold what the local one adds?) rather than a
 * bare boolean. Bounded: a handful of best matches, never the whole store.
 */
export function globalHintsFor(
	globalState: HarnessState,
	kind: RefinementKind,
	entry: Pick<HarnessEntry, "id" | "title">,
): GlobalHint[] {
	const records = globalState.entries[kind];
	const title = normalizeKey(entry.title);
	const hints: GlobalHint[] = [];
	for (const other of Object.values(records)) {
		const otherTitle = normalizeKey(other.title);
		if (otherTitle.length === 0 && other.id !== entry.id) continue;
		const matches =
			other.id === entry.id ||
			(otherTitle.length > 0 && (otherTitle === title || (title.length >= 4 && otherTitle.length >= 4 && (title.includes(otherTitle) || otherTitle.includes(title)))));
		if (matches) {
			hints.push({ id: other.id, title: other.title });
		}
	}
	return hints;
}

/**
 * The auditable local candidates of a session: every non-archived local
 * entry that has not already been promoted (a promoted entry's lifecycle is
 * finished — the global copy is the live one). Each carries its
 * `coveredGlobally` flag so the assessor never wastes a promote on a topic
 * the global store already owns.
 */
/** Staleness threshold: entries with recency below this AND zero usage are stale. */
const STALE_RECENCY_THRESHOLD = 0.1;

export function listLocalCandidates(state: HarnessState, globalState: HarnessState, baseDir?: string): WrapupCandidate[] {
	const usage = baseDir ? loadUsage(baseDir) : undefined;
	const now = Date.now();
	const candidates: WrapupCandidate[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		for (const entry of Object.values(state.entries[kind])) {
			if (entry.scope !== "local") continue;
			if (isArchived(entry)) continue;
			if (typeof entry.metadata[PROMOTED_TO_KEY] === "string") continue;
			const injectionCount = usage ? getUsageCount(usage, kind, entry.id) : 0;
			const stale = injectionCount === 0 && recencyScore(entry, now) < STALE_RECENCY_THRESHOLD;
			const rawNegative = entry.metadata[VALENCE_NEGATIVE_KEY];
			const negativeCount = typeof rawNegative === "number" && Number.isFinite(rawNegative) && rawNegative > 0 ? rawNegative : 0;
			candidates.push({
				kind,
				id: entry.id,
				title: entry.title,
				content: entry.content,
				path: entry.path,
				version: entry.version,
				metadata: entry.metadata,
				coveredGlobally: globalCoverageDetected(globalState, kind, entry),
				globalHints: globalHintsFor(globalState, kind, entry),
				injectionCount,
				stale,
				negativeCount,
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
 *
 * Split promotion (verdict "archive" with a `promote` sub-object): the
 * sub-object is accepted ONLY on archive verdicts and ONLY when both cleaned
 * title and content are non-empty strings — a dropped/malformed sub-object
 * silently degrades to a plain archive (the entry is never half-promoted).
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
			const built: WrapupItem = { key, verdict, reason: typeof item["reason"] === "string" ? item["reason"] : "" };
			if (item["contradicted"] === true) {
				built.contradicted = true;
			}
			if (verdict === "archive" && typeof item["promote"] === "object" && item["promote"] !== null) {
				const sub = item["promote"] as Record<string, unknown>;
				const subTitle = typeof sub["title"] === "string" ? sub["title"].trim() : "";
				const subContent = typeof sub["content"] === "string" ? sub["content"].trim() : "";
				if (subTitle.length > 0 && subContent.length > 0) {
					built.promote = { title: subTitle, content: subContent };
				}
			}
			items.push(built);
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
 * a duplicate, project-scoped, or too-thin global entry. Pure and unit-tested.
 *
 * Guards (2026-08-22 promotion policy):
 * - audited candidate list + title coverage (pre-existing),
 * - project-scoped content markers (absolute paths / session ids) — the
 *   global store is shared across projects and must stay portable,
 * - thin content below the policy floor (framing outweighs the fact),
 * - near-duplicate of an existing global entry by content overlap.
 */
export function filterPromotable(
	items: readonly WrapupItem[],
	globalState: HarnessState,
	candidates: readonly WrapupCandidate[],
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
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
		const scoped = projectScopedReason(`${candidate.title}\n${candidate.content}`, policy);
		if (scoped) {
			skipped.push({ key: item.key, reason: scoped });
			continue;
		}
		const secret = secretLeakReason(`${candidate.title}\n${candidate.content}`);
		if (secret) {
			skipped.push({ key: item.key, reason: secret });
			continue;
		}
		if (candidate.content.length < policy.minPromoteChars) {
			skipped.push({
				key: item.key,
				reason: `too thin to promote (${candidate.content.length} < ${policy.minPromoteChars} chars) — keep local or merge`,
			});
			continue;
		}
		const similar = mostSimilarGlobalEntry(globalState, candidate.kind, candidate.title, candidate.content, policy);
		if (similar) {
			skipped.push({
				key: item.key,
				reason: `near-duplicate of global ${candidate.kind}:${similar.id} "${similar.title}" (overlap ${similar.score.toFixed(2)}) — update that entry instead`,
			});
			continue;
		}
		promotable.push(item);
	}
	return { promotable, skipped };
}

export interface ArchiveReviewSplit {
	/** Archives that may proceed silently: topic already covered, no real
	 * distillation source, or the archive half of an already-approved split. */
	silent: WrapupItem[];
	/**
	 * Archives that would bury possibly-reusable content: not covered
	 * globally AND distilled from real user messages (sourceSeqs present).
	 * These MAY NOT archive silently — the command must get user
	 * confirmation first (the symmetric guard to filterPromotable: it stops
	 * over-archiving, not just over-writing).
	 */
	review: WrapupItem[];
}

/**
 * The symmetric archive guard. `filterPromotable` is one-directional: it
 * stops the model from WRITING duplicate global entries, but nothing stopped
 * an unfounded ARCHIVE from hiding content that was actually only local.
 * Guard criteria: an archive needs user confirmation when it is NOT covered
 * globally AND the entry carries a real distillation source (sourceSeqs /
 * sourceSession — i.e. it was distilled from actual user messages, so it
 * may hold reusable value). Operational/empty entries archive silently as
 * before. Split archives (archive + promote sub-object) skip this check:
 * their promotion already crosses a human approval gate, so the archive is
 * the completion of an approved action, not a silent burial.
 */
export function needsArchiveReview(item: WrapupItem, candidate: WrapupCandidate): boolean {
	if (item.verdict !== "archive") return false;
	if (item.promote) return false;
	if (candidate.coveredGlobally) return false;
	const seqs = candidate.metadata[SOURCE_SEQS_KEY];
	const session = candidate.metadata[SOURCE_SESSION_KEY];
	return (Array.isArray(seqs) && seqs.length > 0) || (typeof session === "string" && session.length > 0);
}

/** Partition archive items into silent vs review-required (see needsArchiveReview). */
export function splitArchiveGuards(items: readonly WrapupItem[], candidates: readonly WrapupCandidate[]): ArchiveReviewSplit {
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const silent: WrapupItem[] = [];
	const review: WrapupItem[] = [];
	for (const item of items) {
		if (item.verdict !== "archive") continue;
		const candidate = byKey.get(item.key);
		if (candidate && needsArchiveReview(item, candidate)) {
			review.push(item);
		} else {
			silent.push(item);
		}
	}
	return { silent, review };
}

/**
 * Apply-time guard for a split promotion (archive + promote sub-object):
 * the cleaned payload must pass the same promotion policy as a whole
 * promote — no global coverage duplicate, no project-scoped content, not
 * too thin, no near-duplicate global entry. A blocked split is dropped (the
 * entry still archives plain) rather than half-promoting a redundancy.
 */
export function splitPromoteBlocked(
	item: WrapupItem,
	globalState: HarnessState,
	kind: RefinementKind,
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): string | undefined {
	if (!item.promote) return "no split payload";
	if (globalCoverageDetected(globalState, kind, { id: "", title: item.promote.title })) {
		return "split promotion duplicates a globally covered topic";
	}
	const scoped = projectScopedReason(`${item.promote.title}\n${item.promote.content}`, policy);
	if (scoped) return `split promotion is ${scoped}`;
	const secret = secretLeakReason(`${item.promote.title}\n${item.promote.content}`);
	if (secret) return `split promotion blocked: ${secret}`;
	if (item.promote.content.length < policy.minPromoteChars) {
		return `split promotion too thin (${item.promote.content.length} < ${policy.minPromoteChars} chars)`;
	}
	const similar = mostSimilarGlobalEntry(globalState, kind, item.promote.title, item.promote.content, policy);
	if (similar) {
		return `split promotion near-duplicates global ${kind}:${similar.id} "${similar.title}" (overlap ${similar.score.toFixed(2)})`;
	}
	return undefined;
}

/**
 * Shared proposal builders for a WHOLE promotion — used by both the
 * `/evolve wrapup` command and the gate's local-fate dimension so the two
 * paths apply IDENTICAL edits (global create + local retirement stamp).
 *
 * The local stamp is a factory: the `promotedTo` id is only known after the
 * global create lands (validation may slugify the id), so the caller applies
 * the global proposal first and stamps the local copy with the created id.
 */
export function wholePromoteProposals(
	item: WrapupItem,
	candidate: WrapupCandidate,
	sessionId: string,
): { global: RefinementProposal; localStamp: (createdId: string) => RefinementProposal } {
	const now = new Date().toISOString();
	return {
		global: {
			summary: `wrapup: promote local ${item.key} to the global store`,
			rationale: item.reason,
			expectedOutcome: `The entry is now visible to every session via the global store (sourcedFromLocal=${sessionId}:${candidate.id}).`,
			edits: [
				{
					action: "create",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					path: candidate.path,
					metadata: {
						...candidate.metadata,
						[SOURCED_FROM_KEY]: `${sessionId}:${candidate.id}`,
						[PROMOTED_AT_KEY]: now,
					},
				},
			],
		},
		localStamp: (createdId) => ({
			summary: `wrapup: stamp local ${item.key} as promoted to ${createdId} and retire it from injection`,
			rationale: item.reason,
			expectedOutcome: `The local copy keeps its data but stops being injected; the global copy is the live one.`,
			edits: [
				{
					action: "update",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					metadata: {
						...candidate.metadata,
						[PROMOTED_TO_KEY]: createdId,
						[PROMOTED_AT_KEY]: now,
						[ARCHIVED_AT_KEY]: now,
					},
				},
			],
		}),
	};
}

/**
 * Shared proposal builders for a SPLIT promotion (A-form): archive a mixed
 * local entry but promote ONLY the cleaned durable part the model extracted.
 * Same usage contract as {@link wholePromoteProposals}: apply the global
 * create, then stamp the original local entry with the created id.
 */
export function splitPromoteProposals(
	item: WrapupItem,
	candidate: WrapupCandidate,
	sessionId: string,
): { global: RefinementProposal; localStamp: (createdId: string) => RefinementProposal } {
	if (!item.promote) throw new Error("split promote proposals require a promote payload");
	const now = new Date().toISOString();
	return {
		global: {
			summary: `wrapup: split — promote cleaned part of ${item.key} to the global store`,
			rationale: item.reason,
			expectedOutcome: `Only the durable part becomes visible globally; the snapshot half stays archived with the original.`,
			edits: [
				{
					action: "create",
					kind: candidate.kind,
					id: candidate.id,
					title: item.promote.title,
					content: item.promote.content,
					path: candidate.path,
					metadata: {
						...candidate.metadata,
						[SOURCED_FROM_KEY]: `${sessionId}:${candidate.id}`,
						[PROMOTED_AT_KEY]: now,
					},
				},
			],
		},
		localStamp: (createdId) => ({
			summary: `wrapup: split — archive original ${item.key}, stamped as promoted to ${createdId}`,
			rationale: item.reason,
			expectedOutcome: `The original leaves injection (data kept, restorable); the cleaned global copy is the live one.`,
			edits: [
				{
					action: "update",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					metadata: {
						...candidate.metadata,
						[PROMOTED_TO_KEY]: createdId,
						[PROMOTED_AT_KEY]: now,
						[ARCHIVED_AT_KEY]: now,
					},
				},
			],
		}),
	};
}

/**
 * Valence stamp (P1 效价反馈): a keep-verdict item the assessor marked
 * contradicted gets its negative-valence counter bumped — the entry stays
 * live but sinks in injection ranking and the next assessment prefers
 * archiving it. Promotes pass untouched (the human-approved global copy is
 * the live truth); archives don't need the stamp (they already leave
 * injection). Undefined when nothing applies.
 */
export function valenceStampProposal(item: WrapupItem, candidate: WrapupCandidate): RefinementProposal | undefined {
	if (item.verdict !== "keep" || !item.contradicted) return undefined;
	return {
		summary: `wrapup: stamp contradicted valence on ${item.key} (${candidate.negativeCount + 1})`,
		rationale: item.reason,
		expectedOutcome:
			"The entry's negative-valence counter rises; injection downranks it and the next assessment prefers archiving it.",
		edits: [
			{
				action: "update",
				kind: candidate.kind,
				id: candidate.id,
				title: candidate.title,
				content: candidate.content,
				metadata: { ...candidate.metadata, [VALENCE_NEGATIVE_KEY]: candidate.negativeCount + 1 },
			},
		],
	};
}

export const WRAPUP_ASSESS_SYSTEM_PROMPT = `You are the /evolve session wrap-up assessor.
A session is ending and its local harness entries need a fate. Classify each
listed entry exactly once:

- "promote" — the content is a stable, durable, CROSS-SESSION reusable lesson:
  a durable user preference, a project-level fact or convention, a reusable
  procedure or skill. Future sessions would benefit from seeing it.
- "archive" — the content is session-specific task progress, one-off noise,
  superseded or obsolete, or already covered by the global store (note
  "covered globally" in the reason), or stale (old + never injected — note
  "stale (injectionCount=0, recency low)" in the reason), or CONTRADICTED —
  newer evidence in the trajectory or the global store disproves or overrides
  the entry's content (note what contradicts it in the reason).
- "keep" — still actively useful to this session, or genuinely uncertain.

Rules:
- CONTRADICTED: when evidence contradicts an entry, set "contradicted": true
  on that item (besides the verdict). Entries marked "(contradicted N×
  before)" were contradicted in earlier assessments — prefer "archive" for
  them unless you have concrete evidence the content is valid again.
- When an entry is marked "covered globally" in the listing, prefer "archive"
  or "keep" over "promote" — promoting a duplicate gains nothing.
- When an entry is marked "stale" (injectionCount=0 and low recency), prefer
  "archive" — the entry has never been used and is old, so it is unlikely to
  be needed again. Only "keep" if the content is clearly valuable despite low
  usage (e.g. a safety policy that rarely triggers but is critical).
- Do not promote local task state, work-in-progress notes, or content tied to
  one session's ephemeral details.
- Skills: only "promote" a skill entry that is a genuinely reusable procedure
  meeting the DSH skill quality standard; one-off workflows are "archive" or
  "keep".
- SPLIT PROMOTION: when an entry mixes a stable, cross-session-reusable part
  WITH session-specific snapshot details, do NOT promote it whole. Instead
  give verdict "archive" WITH a "promote" sub-object holding a CLEANED
  version of only the durable part (a stable title + the persistent facts,
  stripped of dates/states/one-off figures). Ephemeral snapshot content stays
  out of the sub-object — it is left behind in the archive. A sub-object is
  only meaningful on "archive" verdicts.

Return JSON only:
{
  "rationale": "one or two sentences",
  "items": [
    {"key": "memory:foo", "verdict": "promote|archive|keep", "reason": "why"},
    {"key": "memory:bar", "verdict": "archive", "reason": "why", "contradicted": true,
     "promote": {"title": "cleaned stable title", "content": "cleaned durable part only"}}
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
				const stale = candidate.stale ? ` (stale: injectionCount=${candidate.injectionCount}, recency low)` : "";
				const negated = candidate.negativeCount > 0 ? ` (contradicted ${candidate.negativeCount}× before)` : "";
				const hints =
					candidate.globalHints.length > 0
						? ` | global≈${candidate.globalHints.map((hint) => hint.id + ":" + hint.title).join(", ")}`
						: "";
				return `- ${key} [${candidate.path}, v${candidate.version}] "${candidate.title}"${covered}${stale}${negated}${hints}: ${compactText(candidate.content, 220)}`;
			})
			.join("\n");
	const userPrompt = [
		`A local session is wrapping up. Classify each entry below for its fate.`,
		`<local_entries>\n${candidateText}\n</local_entries>`,
		"Return only JSON. Every item must reference one of the keys above.",
	].join("\n\n");

	const text = await streamText(ctx, {
		provider: agent.options.provider,
		model: agent.options.model,
		system: WRAPUP_ASSESS_SYSTEM_PROMPT,
		prompt: userPrompt,
		maxTokens: options.maxOutputTokens ?? 4096,
		signal: options.signal,
	});
	return parseWrapupAssessment(text, candidates);
}
