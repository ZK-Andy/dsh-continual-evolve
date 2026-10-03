/**
 * Shared command-surface utilities: pure input parsing, entry lookup, and
 * result rendering used by the `/evolve` router and every sub-command file.
 * Lives below the interface layer so sub-command files can import it without
 * cycling through command.ts.
 */
import type { HarnessEntry, HarnessState, HarnessScope, RefinementKind, RefinementResult } from "./types.js";
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import type { PromotionPolicy } from "./promotion.js";
import type { RecordLanguagePreference } from "./record-language.js";
import { projectKeyOf } from "./project.js";

export interface CommandGateOptions {
	requireGlobalApproval: boolean;
}

export interface CommandRuntimeOptions {
	rubricKey: Buffer;
	/** When a benchmark decision rejects a candidate, roll the refinement back automatically. */
	autoRollbackOnReject: boolean;
	/** P1: capture failed evolution attempts as draft cases in the auto-regression benchmark. */
	autoCase: boolean;
	/** Mechanical promotion guards for wrapup (2026-08-22 policy). */
	promotionPolicy: PromotionPolicy;
	/**
	 * Initial Memory Agent default from plugin config. The listener is always
	 * registered; this is not a registration gate.
	 */
	autoReview?: boolean;
	/** Plugin `recordLanguage` preference for dialog copy (see `approval.ts`). */
	recordLanguage?: RecordLanguagePreference;
}

/** Parse an optional leading scope token ("global" | "project") off the args. */
export function scopeArg(tokens: string[]): { scope: HarnessScope; rest: string[] } {
	if (tokens[0] === "global") {
		return { scope: "global", rest: tokens.slice(1) };
	}
	if (tokens[0] === "project") {
		return { scope: "project", rest: tokens.slice(1) };
	}
	return { scope: "local", rest: tokens };
}

/**
 * The store id a scope reads/writes from the human command: live session id
 * for local, derived project key for project, undefined for global. Throws
 * for project when the session cwd is unavailable.
 */
export function storeIdForCommand(scope: HarnessScope, invocation: CommandInvocation): string | undefined {
	if (scope === "local") {
		return invocation.agent.id;
	}
	if (scope === "project") {
		const key = projectKeyOf(invocation.agent);
		if (!key) {
			throw new Error("project scope needs the session cwd (unavailable here) — use local or global instead");
		}
		return key;
	}
	return undefined;
}


/**
 * Tokenize a command's raw input with shell-like quoting:
 * - a `#` outside quotes starts a comment (rest of the line is dropped);
 * - whitespace separates tokens;
 * - double or single quotes group words into one token and are stripped.
 *
 * This lets users paste help-text examples verbatim, e.g.
 * `/evolve benchmark add-case <bid> "<title>" "<statement>" "<rubric>"`.
 */
export function tokenizeEvolveInput(rawInput: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const char of rawInput) {
		if (quote !== null) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "#") {
			break; // rest of the line is a comment
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

/** Accept both `<id>` (help-text placeholder form) and bare `id`. */
export function stripAngleBrackets(value: string): string {
	return value.replace(/^<|>$/g, "");
}

/**
 * Locate an entry by id across every kind of a store. Ids are only unique
 * within a kind, so the lookup scans all four and returns the first match
 * (kind + entry) or undefined. Used by archive/unarchive, which take a bare
 * id from the user.
 */
export function findEntryById(state: HarnessState, id: string): [RefinementKind, HarnessEntry] | undefined {
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entry = state.entries[kind][id];
		if (entry) {
			return [kind, entry];
		}
	}
	return undefined;
}

export function parsePositiveInt(value: string, what: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${what} must be a positive integer, got "${value}"`);
	}
	return n;
}

/** Structural stand-in for the host `CommandResult` (kind + text only). */
export interface CommandTextResult {
	kind: "success" | "error";
	text: string;
}

export function success(text: string): CommandTextResult {
	return { kind: "success", text };
}

export function error(text: string): CommandTextResult {
	return { kind: "error", text };
}

/** Human-readable one-refinement rendering shared by every apply path. */
export function renderResult(result: RefinementResult): string {
	const applied = result.appliedEdits.filter((e) => e.applied);
	const failed = result.appliedEdits.filter((e) => !e.applied);
	const lines = [
		`refinement ${result.id}${result.rollbackOf ? ` (rollback of ${result.rollbackOf})` : ""}: ${applied.length} applied, ${failed.length} failed`,
		`summary: ${result.summary}`,
	];
	for (const e of applied) {
		lines.push(`- ${e.action} ${e.kind}:${e.id} (v${(e.after?.version ?? e.before?.version) ?? "?"})`);
	}
	for (const e of failed) {
		lines.push(`- failed ${e.action} ${e.kind}:${e.id ?? "(computed)"} — ${e.error ?? "unknown error"}`);
	}
	lines.push(`expected outcome: ${result.expectedOutcome}`);
	return lines.join("\n");
}
