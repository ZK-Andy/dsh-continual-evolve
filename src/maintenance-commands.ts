/**
 * `/evolve` maintenance and observability subcommands: global-store
 * consolidation, failure aggregation, plugin log inspection, store
 * export/import backup, and entry archive/unarchive.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import { ARCHIVED_AT_KEY, type HarnessScope } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { filterLogBySession, formatLogLine, pluginLogFilePath } from "./logfile.js";
import { collectFailureSummary, formatFailureSummary } from "./failures.js";
import { planConsolidation } from "./consolidate.js";
import { loadUsage } from "./usage.js";
import {
	findEntryById,
	parsePositiveInt,
	renderResult,
	stripAngleBrackets,
	storeIdForCommand,
	success,
	error,
	type CommandTextResult,
} from "./command-util.js";

type ScopeArg = { scope: HarnessScope; rest: string[] };

/** `/evolve archive|unarchive <id> [global|project]` — hide or restore an entry. */
export async function executeArchiveCommand(
	_ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	sub: "archive" | "unarchive",
	parsed: ScopeArg,
	usage: string,
): Promise<CommandTextResult> {
	const id = stripAngleBrackets(parsed.rest[0] ?? "");
	if (!id) {
		return error(`${sub} requires an entry id.\n${usage}`);
	}
	const state = engine.load(parsed.scope, storeIdForCommand(parsed.scope, invocation));
	const found = findEntryById(state, id);
	if (!found) {
		return error(`entry ${id} not found in the ${parsed.scope} store`);
	}
	const [kind, entry] = found;
	const metadata = { ...entry.metadata };
	if (sub === "archive") {
		metadata[ARCHIVED_AT_KEY] = new Date().toISOString();
	} else {
		delete metadata[ARCHIVED_AT_KEY];
	}
	const archived = sub === "archive";
	const result = engine.apply(
		parsed.scope,
		storeIdForCommand(parsed.scope, invocation),
		{
			summary: `${archived ? "Archive" : "Unarchive"} entry ${kind}:${id}`,
			rationale: "Human-invoked archive/unarchive via the /evolve command.",
			expectedOutcome: `Entry ${archived ? "is hidden from injection (data kept, restorable)" : "is injected again"}.`,
			edits: [{ action: "update", kind, id, title: entry.title, content: entry.content, metadata }],
		},
		{ scope: parsed.scope },
	);
	return success(renderResult(result));
}

/** `/evolve consolidate [apply] [merge]` — deterministic global-store hygiene. */
export function executeConsolidateCommand(engine: EvolutionEngine, rest: string[]): CommandTextResult {
	// R3: deterministic global-store hygiene. Report by default; `apply`
	// re-scans fresh state and lands the whole batch as ONE refinement
	// (single snapshot + audit record, fully rollback-able). `merge`
	// (P1 反膨胀) additionally merges conflict-pair content into the
	// surviving original instead of only archiving.
	const apply = rest[0] === "apply";
	const merge = rest.includes("merge");
	const state = engine.load("global", undefined);
	const { candidates, edits } = planConsolidation(state, loadUsage(engine.baseDir), Date.now(), { mergeDuplicates: merge });
	if (candidates.length === 0) {
		return success("global store is already consolidated — no conflict-hinted or stale zero-use entries.");
	}
	const mergeCount = merge ? candidates.filter((candidate) => candidate.mergeInto).length : 0;
	const report = candidates
		.map((candidate, index) => {
			const mergeNote = candidate.mergeInto && merge ? ` → 内容并入 ${candidate.mergeInto.id}` : "";
			return `${index + 1}. [${candidate.kind}:${candidate.id}] ${candidate.title}${mergeNote}\n   ${candidate.reason}`;
		})
		.join("\n");
	if (!apply) {
		return success(`consolidation plan — ${candidates.length} archive candidate(s):\n${report}\n(run "/evolve consolidate apply" to archive all of them in one refinement; add "merge" to fold near-duplicate content into the survivors)`);
	}
	const result = engine.apply(
		"global",
		undefined,
		{
			summary: `Consolidate global store: archive ${candidates.length} entries${mergeCount > 0 ? `, merge ${mergeCount} into survivors` : ""}`,
			rationale: "Human-invoked batch consolidation via /evolve consolidate apply.",
			expectedOutcome: "Candidate entries are hidden from injection (data kept; restorable via /evolve unarchive). Merged survivors carry the near-duplicate content with a mergedFrom provenance stamp.",
			edits,
		},
		{ scope: "global" },
	);
	return success(`${report}\n\napplied:\n${renderResult(result)}`);
}

/** `/evolve failures` — failure-signature aggregation (D1 observation). */
export function executeFailuresCommand(engine: EvolutionEngine): CommandTextResult {
	const { summary, records } = collectFailureSummary(engine.baseDir);
	const parts = formatFailureSummary(summary).split("\n");
	const recent = records
		.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
		.slice(0, 10)
		.map((f) => `  [${f.timestamp ?? "(benchmark)"}] ${f.kind} · ${f.source}: ${f.message.slice(0, 140)}`);
	if (recent.length > 0) {
		parts.push("recent 10:");
		parts.push(...recent);
	}
	return success(parts.join("\n"));
}

/** `/evolve log [tail N] [session <sessionId>]` — plugin file log inspection. */
export function executeLogCommand(engine: EvolutionEngine, rest: string[], usage: string): CommandTextResult {
	let tail = 50;
	let sessionFilter: string | undefined;
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i] ?? "";
		if (token === "session") {
			sessionFilter = stripAngleBrackets(rest[i + 1] ?? "");
			if (!sessionFilter) {
				return error(`log session requires a session id (e.g. /evolve log session session-abc123).\n${usage}`);
			}
			i += 1;
		} else {
			tail = Math.min(Math.max(parsePositiveInt(token, "tail"), 1), 1000);
		}
	}
	const path = pluginLogFilePath(engine.baseDir);
	if (!existsSync(path)) {
		return success(`(no plugin log yet — ${path} is created on the first log message)`);
	}
	const lines = readFileSync(path, "utf8").trimEnd().split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) {
		return success(`(empty plugin log: ${path})`);
	}
	const filtered = sessionFilter ? filterLogBySession(lines, sessionFilter) : lines;
	const shown = filtered.slice(-tail);
	const scopeNote = sessionFilter ? `, ${filtered.length} for session ${sessionFilter}` : "";
	return success(
		`plugin log ${path} (${lines.length} lines${scopeNote}, showing last ${shown.length}):\n${shown.map(formatLogLine).join("\n")}`,
	);
}

/** `/evolve export [global|project] <path>` — backup a store to a JSON file. */
export function executeExportCommand(engine: EvolutionEngine, invocation: CommandInvocation, parsed: ScopeArg, usage: string): CommandTextResult {
	const path = parsed.rest[0];
	if (!path) {
		return error(`export requires an output path.\n${usage}`);
	}
	const payload = engine.exportStore(parsed.scope, storeIdForCommand(parsed.scope, invocation));
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return success(`exported ${parsed.scope} store (${Object.values(payload.entries).reduce((n, e) => n + Object.keys(e).length, 0)} entries, ${payload.history.length} refinements) to ${path}`);
}

/** `/evolve import [global|project] <path>` — restore a store from an export file. */
export function executeImportCommand(engine: EvolutionEngine, invocation: CommandInvocation, parsed: ScopeArg, path: string | undefined): CommandTextResult {
	if (!path) {
		return error(`import requires an input path.`);
	}
	const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
	const summary = engine.importStore(parsed.scope, storeIdForCommand(parsed.scope, invocation), payload);
	return success(`imported ${parsed.scope} store from ${path} (${summary.entries} entries, ${summary.refinements} refinements)`);
}
