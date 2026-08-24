/**
 * Retrieval primitives for injection ranking: CJK-aware tokenization plus a
 * dependency-free, field-weighted BM25 scorer (ADR
 * `implemented/feature/2026-08-24-cjk-bigram-bm25-retrieval.md`).
 *
 * Why this shape:
 * - the old scorer tokenized whole CJK runs as single tokens compared for
 *   exact equality, so any rewording of a Chinese query missed every entry
 *   (「检索升级」 never matched 「全文检索方案」); overlapping character
 *   bigrams — the standard cjk_bigram analyzer shape (Elasticsearch/
 *   OpenSearch) — fix recall while keeping English behavior identical;
 * - raw hit counts weighted common words and distinctive terms alike; BM25's
 *   IDF separates them. We use Lucene's non-negative variant
 *   `ln(1 + (N - df + 0.5) / (df + 0.5))` so EVERY matched token scores > 0
 *   and unmatched documents score exactly 0, preserving rankEntries'
 *   "relevant outranks recent-but-irrelevant" ordering invariant;
 * - the index lifetime is one ranking call. Stores hold tens~hundreds of
 *   entries (measured full rebuild + score: single-digit milliseconds), the
 *   JSON state files stay the single source of truth, and npm installers
 *   carry zero native/WASM baggage — better-sqlite3 FTS5, sql.js, MiniSearch,
 *   FlexSearch were all evaluated and rejected (see the ADR's alternatives).
 */
import type { HarnessEntry } from "./types.js";

/** BM25 term-saturation constant (Okapi k1). */
export const BM25_K1 = 1.5;
/** BM25 document-length normalization constant (Okapi b). */
export const BM25_B = 0.75;
/** Multiplier for title-field matches (title hits outweigh body hits 2:1). */
export const TITLE_FIELD_WEIGHT = 2;

/**
 * One pass, two run shapes: ASCII alphanumeric words, or maximal CJK runs.
 * Runs never mix scripts because the alternation splits at the boundary, so
 * 「深色主题dark主题」 tokenizes as 深色/色主/主题, "dark", 主题.
 */
const TOKEN_RUN_PATTERN = /[a-z0-9]+|[\u4e00-\u9fff]+/g;
const ASCII_RUN_PATTERN = /^[a-z0-9]+$/;

/**
 * Tokenize text for relevance scoring: lowercase ASCII runs become word
 * tokens; CJK runs become overlapping character bigrams (a single-character
 * run stays a unigram). Deterministic and allocation-light — safe to call per
 * injection build.
 *
 * @param text Arbitrary entry or query text.
 * @returns Tokens in occurrence order (duplicates kept; consumers dedupe when
 *          order-independent weighting is wanted).
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const match of text.toLowerCase().matchAll(TOKEN_RUN_PATTERN)) {
		const run = match[0];
		if (ASCII_RUN_PATTERN.test(run)) {
			tokens.push(run);
		} else if (run.length === 1) {
			tokens.push(run);
		} else {
			for (let i = 0; i < run.length - 1; i += 1) {
				tokens.push(run.slice(i, i + 2));
			}
		}
	}
	return tokens;
}

/** Per-field corpus statistics for one ranking pass. */
interface FieldStats {
	/** Term-frequency map per document, positioned like {@link RelevanceIndex.positions}. */
	readonly tfs: ReadonlyArray<ReadonlyMap<string, number>>;
	/** Token count per document (this field's dl for BM25 length normalization). */
	readonly lengths: ReadonlyArray<number>;
	/** Document frequency per distinct term across the corpus. */
	readonly df: ReadonlyMap<string, number>;
	/** Average token count across the corpus (0 when empty). */
	readonly averageLength: number;
}

/** Precomputed corpus statistics backing {@link relevanceScore}. */
export interface RelevanceIndex {
	/** Number of documents in the corpus. */
	readonly size: number;
	/** Identity positions: the exact entry objects the index was built from. */
	readonly positions: ReadonlyMap<object, number>;
	readonly titles: FieldStats;
	readonly bodies: FieldStats;
}

function buildFieldStats(fieldTokens: ReadonlyArray<readonly string[]>): FieldStats {
	const tfs = fieldTokens.map((tokens) => {
		const tf = new Map<string, number>();
		for (const token of tokens) {
			tf.set(token, (tf.get(token) ?? 0) + 1);
		}
		return tf;
	});
	const df = new Map<string, number>();
	let totalLength = 0;
	for (let position = 0; position < tfs.length; position += 1) {
		const tf = tfs[position]!;
		let length = 0;
		for (const count of tf.values()) {
			length += count;
		}
		totalLength += length;
		for (const token of tf.keys()) {
			df.set(token, (df.get(token) ?? 0) + 1);
		}
	}
	return {
		tfs,
		lengths: fieldTokens.map((tokens) => tokens.length),
		df,
		averageLength: tfs.length === 0 ? 0 : totalLength / tfs.length,
	};
}

/**
 * Build the corpus statistics (per-field tf, df, average length) for one
 * ranking call. Pure: the index reads its input snapshot and never mutates
 * the entries.
 *
 * @param entries The candidate entries being ranked this call.
 * @returns An index that answers {@link relevanceScore} for exactly these
 *          entries (identity-keyed).
 */
export function buildRelevanceIndex(entries: readonly HarnessEntry[]): RelevanceIndex {
	const titles: string[][] = [];
	const bodies: string[][] = [];
	for (const entry of entries) {
		titles.push(tokenize(entry.title));
		bodies.push(tokenize(`${entry.content} ${entry.path}`));
	}
	return {
		size: entries.length,
		positions: new Map(entries.map((entry, position) => [entry as object, position])),
		titles: buildFieldStats(titles),
		bodies: buildFieldStats(bodies),
	};
}

/** One field's BM25 contribution for a single term (0 when the term is absent). */
function bm25Term(termFrequency: number, documentFrequency: number, corpusSize: number, docLength: number, averageLength: number): number {
	if (termFrequency <= 0 || documentFrequency <= 0) {
		return 0;
	}
	const inverseDocumentFrequency = Math.log(1 + (corpusSize - documentFrequency + 0.5) / (documentFrequency + 0.5));
	const normalization = averageLength > 0 ? 1 - BM25_B + BM25_B * (docLength / averageLength) : 1;
	return inverseDocumentFrequency * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + BM25_K1 * normalization));
}

/**
 * Field-weighted BM25 score of `entry` against `query` within `index`:
 * `TITLE_FIELD_WEIGHT × bm25(title) + bm25(body)`. Query tokens are deduped,
 * so repeating a word adds no weight.
 *
 * @returns A score > 0 when at least one query token occurs in the entry
 *          (either field), and exactly 0 otherwise — the property rankEntries'
 *          relevance-first ordering relies on. Never throws; an entry outside
 *          the index simply scores 0.
 */
export function relevanceScore(index: RelevanceIndex, entry: HarnessEntry, query: string): number {
	const position = index.positions.get(entry);
	if (position === undefined || index.size === 0) {
		return 0;
	}
	const seen = new Set<string>();
	let titleScore = 0;
	let bodyScore = 0;
	for (const token of tokenize(query)) {
		if (seen.has(token)) {
			continue;
		}
		seen.add(token);
		const titleDf = index.titles.df.get(token) ?? 0;
		if (titleDf > 0) {
			titleScore += bm25Term(index.titles.tfs[position]?.get(token) ?? 0, titleDf, index.size, index.titles.lengths[position] ?? 0, index.titles.averageLength);
		}
		const bodyDf = index.bodies.df.get(token) ?? 0;
		if (bodyDf > 0) {
			bodyScore += bm25Term(index.bodies.tfs[position]?.get(token) ?? 0, bodyDf, index.size, index.bodies.lengths[position] ?? 0, index.bodies.averageLength);
		}
	}
	return TITLE_FIELD_WEIGHT * titleScore + bodyScore;
}
