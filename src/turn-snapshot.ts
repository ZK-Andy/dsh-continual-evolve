/**
 * Turn-boundary snapshots for the automatic review gate.
 *
 * The scheduler must see a bounded, mechanically filtered slice of the
 * current session, not a fresh full-history LLM request on every turn. This
 * module owns the snapshot boundary, cursor-compatible incremental rows, and
 * the cheap eligibility checks that run before any model call.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { sessionEventsOf } from "./inject.js";
import { projectKeyOf } from "./project.js";

/** Why a scheduler snapshot was captured. */
export type TurnSnapshotReason = "turn_snapshot" | "compact";

/** Mechanical reasons a snapshot can be skipped without an LLM call. */
export type SnapshotSkipReason =
	| "no-new-events"
	| "internal-agent"
	| "direct-memory-write"
	| "no-user-prose";

/** One immutable scheduler input. The cursor is a durable event boundary. */
export interface TurnSnapshot {
	readonly sessionId: string;
	readonly projectKey?: string;
	readonly turn: number;
	readonly reason: TurnSnapshotReason;
	readonly cursor: string;
	readonly events: readonly unknown[];
	readonly trajectory: string;
	readonly userText: string;
	readonly sourceSeqs: readonly number[];
	readonly eligible: boolean;
	readonly skipReason?: SnapshotSkipReason;
}

/** Eligibility result kept separate so tests and future extractors share it. */
export interface SnapshotEligibility {
	readonly eligible: boolean;
	readonly reason?: SnapshotSkipReason;
	readonly userText: string;
}

/** DSH's surface reader is duck-typed to keep this module host-generation safe. */
interface SurfaceReader {
	readSurface(sessionId: string): Promise<{ events: unknown[] }>;
}

/**
 * Capture the current durable surface and select only rows after `cursor`.
 * A seq-bearing session uses `seq:<n>`; older/test surfaces fall back to an
 * event-count cursor so the scheduler still has a deterministic boundary.
 */
export async function captureTurnSnapshot(
	ctx: Context,
	agent: Agent,
	opts: {
		turn: number;
		reason: TurnSnapshotReason;
		cursor?: string;
		maxChars: number;
	},
): Promise<TurnSnapshot> {
	const allEvents = await readSurface(ctx, agent);
	const cursor = boundaryCursor(allEvents);
	const events = eventsAfterCursor(allEvents, opts.cursor);
	const eligibility = evaluateSnapshotEligibility(events, isInternalAgent(agent));
	const projectKey = projectKeyOf(agent);
	return {
		sessionId: agent.id,
		...(projectKey ? { projectKey } : {}),
		turn: opts.turn,
		reason: opts.reason,
		cursor,
		events,
		trajectory: eligibility.eligible ? serializeSnapshotEvents(events, opts.maxChars) : "",
		userText: eligibility.userText,
		sourceSeqs: directUserSeqs(events),
		eligible: eligibility.eligible,
		...(eligibility.reason ? { skipReason: eligibility.reason } : {}),
	};
}

/**
 * Decide whether the incremental rows deserve a model call. This intentionally
 * does not decide whether a fact is valuable; that remains the review model's
 * job. It only removes mechanical noise before the scheduler spends tokens.
 */
export function evaluateSnapshotEligibility(events: readonly unknown[], internalAgent = false): SnapshotEligibility {
	if (internalAgent) return { eligible: false, reason: "internal-agent", userText: "" };
	if (events.length === 0) return { eligible: false, reason: "no-new-events", userText: "" };
	if (containsDirectMemoryWrite(events)) return { eligible: false, reason: "direct-memory-write", userText: "" };
	const userText = directUserText(events);
	if (userText.length < 3) return { eligible: false, reason: "no-user-prose", userText };
	return { eligible: true, userText };
}

/** True when an assistant row records an explicit evolve memory mutation. */
export function containsDirectMemoryWrite(events: readonly unknown[]): boolean {
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const row = event as Record<string, unknown>;
		if (row.type === "tool/call" || row.type === "tool-call") {
			if (isMemoryMutationName(readNestedString(row.data, ["name", "tool", "toolName"]))) return true;
		}
		if (row.type === "assistant/message" && containsMemoryMutationName(row.data)) return true;
	}
	return false;
}

/** Serialize only user/assistant text, retaining the bounded tail. */
export function serializeSnapshotEvents(events: readonly unknown[], maxChars: number): string {
	const lines: string[] = [];
	for (const raw of events) {
		if (!raw || typeof raw !== "object") continue;
		const event = raw as { type?: unknown; data?: { content?: unknown } };
		if (event.type === "user/message" && !isDirectUserEvent(raw)) continue;
		const role = event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : null;
		if (role === null) continue;
		const text = contentText(event.data?.content).trim();
		if (text.length > 0) lines.push(`${role}: ${text}`);
	}
	const joined = lines.join("\n");
	return joined.length <= maxChars ? joined : joined.slice(-maxChars);
}

/** A DSH subagent header is an internal source when its origin says so. */
export function isInternalAgent(agent: Agent | undefined): boolean {
	const header = (agent as unknown as { session?: { header?: { origin?: unknown; isSubagent?: unknown } } } | undefined)?.session?.header;
	return header?.origin === "subagent" || header?.origin === "internal" || header?.isSubagent === true;
}

async function readSurface(ctx: Context, agent: Agent): Promise<readonly unknown[]> {
	const reader = (ctx as unknown as { sessionQuery?: SurfaceReader }).sessionQuery;
	if (reader) {
		const snapshot = await reader.readSurface(agent.id);
		return Array.isArray(snapshot.events) ? snapshot.events : [];
	}
	return sessionEventsOf(agent);
}

function boundaryCursor(events: readonly unknown[]): string {
	const seqs = events.map(eventSeq).filter((seq): seq is number => seq !== undefined);
	return seqs.length > 0 ? `seq:${Math.max(...seqs)}` : `index:${events.length}`;
}

function eventsAfterCursor(events: readonly unknown[], cursor: string | undefined): readonly unknown[] {
	if (cursor === undefined) return events;
	if (cursor.startsWith("seq:")) {
		const boundary = Number(cursor.slice(4));
		if (!Number.isFinite(boundary)) return events;
		return events.filter((event) => {
			const seq = eventSeq(event);
			return seq === undefined || seq > boundary;
		});
	}
	if (cursor.startsWith("index:")) {
		const boundary = Number(cursor.slice(6));
		return Number.isInteger(boundary) && boundary >= 0 ? events.slice(boundary) : events;
	}
	return events;
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

function isDirectUserEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const row = event as { type?: unknown; data?: { source?: { kind?: unknown; synthetic?: unknown }; visibility?: unknown; content?: unknown } };
	if (row.type !== "user/message") return false;
	if (row.data?.visibility === "model-only") return false;
	if (row.data?.source?.synthetic === true) return false;
	if (row.data?.source?.kind !== undefined && row.data.source.kind !== "user") return false;
	return contentText(row.data?.content).trim().length > 0;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!block || typeof block !== "object") return "";
			const value = block as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown };
			if (value.synthetic === true || value.ignored === true || (value.type !== undefined && value.type !== "text")) return "";
			return typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join(" ");
}

function eventSeq(event: unknown): number | undefined {
	if (!event || typeof event !== "object") return undefined;
	const seq = (event as { seq?: unknown }).seq;
	return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}

function containsMemoryMutationName(value: unknown): boolean {
	if (typeof value === "string") return isMemoryMutationName(value);
	if (Array.isArray(value)) return value.some(containsMemoryMutationName);
	if (!value || typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).some(containsMemoryMutationName);
}

function isMemoryMutationName(value: string | undefined): boolean {
	return value === "evolve_add" || value === "evolve_update" || value === "evolve_delete";
}

function readNestedString(value: unknown, keys: readonly string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	for (const key of keys) {
		if (typeof row[key] === "string") return row[key];
	}
	return undefined;
}
