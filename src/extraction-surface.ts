/**
 * Trajectory slicing for the extraction pipeline: the bounded, mechanically
 * filtered increment of one session since the last extraction cursor.
 *
 * The mechanics carry over from the v0.10.4 turn snapshots (proven against
 * real DSH session surfaces): a `seq:<n>` cursor selects rows after the last
 * boundary, direct-user rows drive the eligibility gate, and only
 * user/assistant text is serialized. Judgment about what deserves a memory
 * is the extraction model's job — this module only removes mechanical noise
 * before any tokens are spent.
 */

/** ZCode's minimum lexical words in the increment's direct user text. */
export const MEMORY_MIN_USER_WORDS = 3;
/** Default ceiling for the serialized increment handed to the model. */
export const DEFAULT_INCREMENT_MAX_CHARS = 40_000;

/** Why an extraction run was skipped without (or before) an LLM call. */
export type SkipReason =
	| "internal-agent"
	| "no-new-events"
	| "no-user-prose"
	| "direct-memory-write"
	| "no-route"
	| "empty-increment";

/** CJK-aware word segmenter (lexical words, not whitespace splits). */
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/** The session surface reader this plugin consumes (duck-typed). */
export interface SurfaceReader {
	readSurface(sessionId: string): Promise<{ events: unknown[] }>;
}

export interface SliceInput {
	events: readonly unknown[];
	internalAgent: boolean;
	minUserWords?: number;
}

export interface Slice {
	/** The increment rows after the cursor (already selected by the caller). */
	events: readonly unknown[];
	eligible: boolean;
	skipReason?: SkipReason;
	/** Direct user text in the increment (the extraction model's evidence). */
	userText: string;
	/** Seq numbers of the direct user rows, for record provenance. */
	userSeqs: number[];
}

/**
 * Judge whether the increment deserves a model call. This intentionally does
 * not decide whether a fact is valuable — only that there is new, real user
 * prose to extract from.
 */
export function evaluateSlice(input: SliceInput): Slice {
	const { events } = input;
	const userSeqs = directUserSeqs(events);
	if (input.internalAgent) {
		return { events, eligible: false, skipReason: "internal-agent", userText: "", userSeqs };
	}
	if (events.length === 0) {
		return { events, eligible: false, skipReason: "no-new-events", userText: "", userSeqs };
	}
	if (containsExplicitMemoryWrite(events)) {
		return { events, eligible: false, skipReason: "direct-memory-write", userText: "", userSeqs };
	}
	const userText = directUserText(events);
	if (countWords(userText) < (input.minUserWords ?? MEMORY_MIN_USER_WORDS)) {
		return { events, eligible: false, skipReason: "no-user-prose", userText, userSeqs };
	}
	return { events, eligible: true, userText, userSeqs };
}

/**
 * True when the increment already contains a `memory_write` tool call: the
 * user's explicit instruction was handled in-turn by the gated write path,
 * so re-extracting the same turn would only duplicate it.
 */
export function containsExplicitMemoryWrite(events: readonly unknown[]): boolean {
	for (const raw of events) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const row = raw as { type?: unknown; data?: { name?: unknown; tool?: unknown; toolName?: unknown } };
		if (row.type !== "tool/call" && row.type !== "tool-call") {
			continue;
		}
		const name = row.data?.name ?? row.data?.tool ?? row.data?.toolName;
		if (typeof name === "string" && name.trim() === "memory_write") {
			return true;
		}
	}
	return false;
}

/** The new boundary after processing these events: `seq:<max>` or the count. */
export function boundaryCursorOf(events: readonly unknown[]): string {
	const seqs = events.map(eventSeq).filter((seq): seq is number => seq !== undefined);
	return seqs.length > 0 ? `seq:${Math.max(...seqs)}` : `index:${events.length}`;
}

/** Numeric boundary of a `seq:<n>` cursor (undefined for index cursors). */
export function seqOfCursor(cursor: string | undefined): number | undefined {
	if (cursor === undefined || !cursor.startsWith("seq:")) {
		return undefined;
	}
	const value = Number(cursor.slice(4));
	return Number.isInteger(value) ? value : undefined;
}

/** Rows after the cursor: everything with a seq beyond it (seq-less rows stay). */
export function eventsAfterCursor(events: readonly unknown[], cursor: string | undefined): readonly unknown[] {
	const boundary = seqOfCursor(cursor);
	if (boundary === undefined) {
		return cursor === undefined ? events : [];
	}
	return events.filter((event) => {
		const seq = eventSeq(event);
		return seq === undefined || seq > boundary;
	});
}

/**
 * Serialize only user/assistant text, keeping the bounded tail. Tool calls,
 * reasoning, and metadata never enter the prompt.
 */
export function serializeIncrement(events: readonly unknown[], maxChars: number = DEFAULT_INCREMENT_MAX_CHARS): string {
	const lines: string[] = [];
	for (const raw of events) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const event = raw as { type?: unknown; data?: { content?: unknown } };
		const role = event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : null;
		if (role === null) {
			continue;
		}
		if (role === "user" && !isDirectUserEvent(raw)) {
			continue;
		}
		const text = contentText(event.data?.content).trim();
		if (text.length > 0) {
			lines.push(`${role}: ${text}`);
		}
	}
	const joined = lines.join("\n");
	return joined.length <= maxChars ? joined : joined.slice(-maxChars);
}

/** A DSH subagent header is an internal source when its origin says so. */
export function isInternalAgent(agent: unknown): boolean {
	const header = (agent as { session?: { header?: { origin?: unknown; isSubagent?: unknown } } } | undefined)
		?.session?.header;
	return header?.origin === "subagent" || header?.origin === "internal" || header?.isSubagent === true;
}

/** Lexical word count via Intl.Segmenter — CJK text counts characters as words. */
export function countWords(text: string): number {
	return [...WORD_SEGMENTER.segment(text)].filter((segment) => segment.isWordLike).length;
}

/** Direct user rows: real user text, not synthetic injections or tool output. */
function isDirectUserEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") {
		return false;
	}
	const row = event as {
		type?: unknown;
		data?: { source?: { kind?: unknown; synthetic?: unknown }; visibility?: unknown; content?: unknown };
	};
	if (row.type !== "user/message") {
		return false;
	}
	if (row.data?.visibility === "model-only") {
		return false;
	}
	if (row.data?.source?.synthetic === true) {
		return false;
	}
	if (row.data?.source?.kind !== undefined && row.data.source.kind !== "user") {
		return false;
	}
	return contentText(row.data?.content).trim().length > 0;
}

function directUserText(events: readonly unknown[]): string {
	return events
		.filter(isDirectUserEvent)
		.map((event) => contentText((event as { data?: { content?: unknown } }).data?.content).trim())
		.filter(Boolean)
		.join("\n");
}

function directUserSeqs(events: readonly unknown[]): number[] {
	return events
		.filter(isDirectUserEvent)
		.map(eventSeq)
		.filter((seq): seq is number => seq !== undefined);
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (typeof block === "string") {
				return block;
			}
			if (!block || typeof block !== "object") {
				return "";
			}
			const value = block as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown };
			if (value.synthetic === true || value.ignored === true || (value.type !== undefined && value.type !== "text")) {
				return "";
			}
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join(" ");
}

function eventSeq(event: unknown): number | undefined {
	if (!event || typeof event !== "object") {
		return undefined;
	}
	const seq = (event as { seq?: unknown }).seq;
	return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}
