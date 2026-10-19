/**
 * One extraction run's chain item and its dependency-free helpers.
 *
 * This module is a leaf on purpose: it holds the run context type
 * (ExtractionItem), the run id (runIdOf), and the throw formatter
 * (errorText) with zero value imports, so the ring (extraction-ring.ts),
 * the proposal link (extraction-propose.ts), and the entry
 * (extraction.ts) can all share the run vocabulary without forming a
 * value-import cycle. It used to live inside extraction-ring.ts, which
 * made extraction-propose.ts import the ring for values while the ring
 * imported proposeLink back — a genuine runtime cycle that G2
 * (verify-dep-cycles.ts) caught when the gate batch landed.
 */
import type { ExtractionDeps, ExtractionResult, ExtractionTarget, RunOptions } from "./extraction.js";
import type { ClassifyResult } from "./extraction-prompt.js";
import type { ModelSelection } from "./model-route.js";
import type { SubagentLoader } from "./subagent.js";
import type { LedgerEntry } from "../store.js";

/** Head length of an unexpected error's message/stack trace kept in the ledger files column. */
const UNEXPECTED_ERROR_RAW_MAX = 2048;

/** One run's walk through the chain: the context every link reads and fills in. */
export interface ExtractionItem {
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
	/** The classification prior (P2 two-stage); `undefined` when it never answered. */
	classify: ClassifyResult | undefined;
	/** The classification call's observed usage, carried onto the run's own row. */
	classifyUsage: unknown;
	/** Why the classify call left no prior (fail open); `undefined` when it answered. */
	classifyError: string | undefined;
	/** The exact classify prompt text (P2 audit input); `undefined` when classify never ran. */
	classifyPromptText: string | undefined;
	/** The terminal outcome, set by the link that handles the item. */
	result?: ExtractionResult;
}

/**
 * The run id every ledger row of one extraction run carries.
 *
 * @param item - The run whose session and boundary identify the row group.
 * @returns A stable ledger run id such as extract:session:tail.
 */
export function runIdOf(item: Pick<ExtractionItem, "target" | "boundarySeq">): string {
	return `extract:${item.target.sessionId}:${item.boundarySeq ?? "tail"}`;
}

/**
 * Split an unexpected throw into a ledger-sized reason head and file body.
 *
 * @param error - The caught throw, of unknown shape.
 * @returns The one-line message plus the message/stack body, truncated to the ledger budget.
 */
export function errorText(error: unknown): { message: string; detail: string } {
	const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
	const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : message;
	return { message, detail: `${message}\n${stack}`.slice(0, UNEXPECTED_ERROR_RAW_MAX) };
}
