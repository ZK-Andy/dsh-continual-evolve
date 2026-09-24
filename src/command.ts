/**
 * The human-facing `/evolve` command: inspect and drive the continual
 * harness from the chat UI without the model in between.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { HarnessEntry, HarnessScope, HarnessState, RefinementKind, RefinementResult } from "./types.js";
import { ARCHIVED_AT_KEY } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import { planWithLlm } from "./planner.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireGlobalApproval } from "./approval.js";
import { saveHarnessState } from "./state.js";
import { appendResult, pruneJsonlFile, storePaths } from "./store.js";
import { DEFAULT_REFINEMENTS_RETAIN } from "./store.js";
import { entrySourceOf } from "./source.js";
import { filterLogBySession, formatLogLine, pluginLogFilePath } from "./logfile.js";
import { collectFailureSummary, formatFailureSummary } from "./failures.js";
import { executeGoalCommand } from "./goal-command.js";
import { executeMountCommand, executeUnmountCommand } from "./mount-command.js";
import { executeBenchmarkCommand } from "./benchmark-command.js";
import { executeWrapupCommand } from "./wrapup-command.js";
import type { PromotionPolicy } from "./promotion.js";
import { projectKeyOf } from "./project.js";
import { loadUsage, getUsageCount } from "./usage.js";
import { loadGateRuntime, saveGateRuntime } from "./runtime.js";
import { planConsolidation } from "./consolidate.js";
import { loadTokenUsage, renderTokenUsageReport } from "./token-usage.js";

const USAGE = `Usage:
  /evolve                  show this help and the current local store
  /evolve list [project|global]    list entries (default local staging; "project" = this project's cross-session store, "global" = cross-project store)
  /evolve history [global] show applied refinements (rollback ids)
  /evolve rollback <id> [global]  deterministically revert a refinement
  /evolve plan [msg]       run the LLM planner against the current store
  /evolve wrapup           assess this session's local entries: promote reusable ones
                           to the global store (approval required), archive one-offs
  /evolve archive <id> [global]   hide an entry from injection (data kept, restorable)
  /evolve unarchive <id> [global] restore an archived entry
  /evolve demote <id>             hide a (global) entry from injection, keep data
  /evolve consolidate [apply] [merge]
                                  report (or apply) a batch archive of conflict-hinted
                                  and stale zero-use global entries; "merge" folds
                                  near-duplicate content into the surviving original
  /evolve log [tail N]            show the recent plugin log (default 50 lines)
  /evolve failures               aggregated failure counts (gate + benchmark, by class)
  /evolve export [global] <path>  backup a store to a JSON file
  /evolve import [global] <path>  restore a store from an export file
  /evolve mount <skillId>    hot-mount a skill entry as a live cordis plugin
  /evolve mount list         list hot-mounted plugins
  /evolve unmount <id>       remove a hot-mounted plugin
  /evolve goal               show the evolution goal (round-driven auto-review)
  /evolve goal <objective>   create/update the evolution goal
  /evolve goal done          complete the evolution goal
  /evolve pause | resume     pause/resume the auto-review gate (manual tools and commands keep working)
  /evolve status             gate state (patch flag + runtime switch) plus store entry counts
  /evolve usage              injection counts + exact direct-call token usage (benchmark subagents excluded)`;

export interface CommandGateOptions {
	requireGlobalApproval: boolean;
}

export interface CommandRuntimeOptions {
	rubricKey: Buffer;
	/** When a benchmark decision rejects a candidate, roll the refinement back automatically. */
	autoRollbackOnReject: boolean;
	/** P1: capture failed evolution attempts as draft cases in the auto-regression benchmark. */
	autoCase: boolean;
	/** Mechanical promotion guards for wrapup/fate (2026-08-22 policy). */
	promotionPolicy: PromotionPolicy;
	/**
	 * Static patch flag for the auto-review gate (#21 status display).
	 * Absent (older wiring/tests) renders as unknown — the runtime pause
	 * switch still works.
	 */
	autoReview?: boolean;
}

export function registerEvolveCommand(ctx: Context, engine: EvolutionEngine, opts: CommandGateOptions, runtime: CommandRuntimeOptions): void {
	ctx.commands.register({
		name: "evolve",
		description: "inspect and evolve the continual harness state (memories, skills, prompt notes, subagent specs)",
		input: { hint: "[list [global] | history [global] | rollback <id> [global] | plan [msg]]" },
		handler: (invocation) => executeEvolveCommand(ctx, engine, invocation, opts, runtime),
	});
}

function scopeArg(tokens: string[]): { scope: HarnessScope; rest: string[] } {
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
function storeIdForCommand(scope: HarnessScope, invocation: CommandInvocation): string | undefined {
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

async function executeEvolveCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	opts: CommandGateOptions,
	runtime: CommandRuntimeOptions,
): Promise<CommandResult> {
	const tokens = tokenizeEvolveInput(invocation.rawInput);
	const sub = tokens[0] ?? "";
	const rest = tokens.slice(1);
	const sessionId = invocation.agent.id;

	try {
		switch (sub) {
			case "":
			case "help":
				return success(`${USAGE}\n\n${formatHarnessStateForPrompt(engine.load("local", sessionId))}`);
			case "list": {
				const { scope } = scopeArg(rest);
				return success(formatHarnessStateForPrompt(engine.load(scope, storeIdForCommand(scope, invocation))));
			}
			case "history": {
				const { scope } = scopeArg(rest);
				const history = engine.history(scope, storeIdForCommand(scope, invocation));
				return success(historyForPrompt(history) || "(no refinements yet)");
			}
			case "rollback": {
				const { scope, rest: after } = scopeArg(rest);
				const id = stripAngleBrackets(after[0] ?? "");
				if (!id) {
					return error(`rollback requires a refinement id.\n${USAGE}`);
				}
				const result = engine.rollback(scope, storeIdForCommand(scope, invocation), id);
				return success(renderResult(result));
			}
			case "archive":
			case "unarchive":
			case "demote": {
				const { scope, rest: after } = scopeArg(rest);
				const id = stripAngleBrackets(after[0] ?? "");
				if (!id) {
					return error(`${sub} requires an entry id.\n${USAGE}`);
				}
				if (sub === "demote") {
					return demoteEntry(engine, id, sessionId, projectKeyOf(invocation.agent));
				}
				const state = engine.load(scope, storeIdForCommand(scope, invocation));
				const found = findEntryById(state, id);
				if (!found) {
					return error(`entry ${id} not found in the ${scope} store`);
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
					scope,
					storeIdForCommand(scope, invocation),
					{
						summary: `${archived ? "Archive" : "Unarchive"} entry ${kind}:${id}`,
						rationale: "Human-invoked archive/unarchive via the /evolve command.",
						expectedOutcome: `Entry ${archived ? "is hidden from injection (data kept, restorable)" : "is injected again"}.`,
						edits: [{ action: "update", kind, id, title: entry.title, content: entry.content, metadata }],
					},
					{ scope },
				);
				return success(renderResult(result));
			}
			case "consolidate": {
				// R3: deterministic global-store hygiene. Report by default;
				// `apply` re-scans fresh state and lands the whole batch as ONE
				// refinement (single snapshot + audit record, fully rollback-able).
				// `merge` (P1 反膨胀) additionally merges conflict-pair content
				// into the surviving original instead of only archiving.
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
			case "failures": {
				// /evolve failures — failure-signature aggregation (D1 observation):
				// failed review-gate records + failed benchmark cells, counted by class.
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
			case "log": {
				// /evolve log [tail N] [session <sessionId>]
				let tail = 50;
				let sessionFilter: string | undefined;
				for (let i = 0; i < rest.length; i += 1) {
					const token = rest[i] ?? "";
					if (token === "session") {
						sessionFilter = stripAngleBrackets(rest[i + 1] ?? "");
						if (!sessionFilter) {
							return error(`log session requires a session id (e.g. /evolve log session session-abc123).\n${USAGE}`);
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
			case "export": {
				const { scope, rest: after } = scopeArg(rest);
				const path = after[0];
				if (!path) {
					return error(`export requires an output path.\n${USAGE}`);
				}
				const state = engine.load(scope, storeIdForCommand(scope, invocation));
				const history = engine.history(scope, storeIdForCommand(scope, invocation));
				const payload = {
					version: 1,
					scope,
					schema: state.schema,
					entries: state.entries,
					refinements: state.refinements,
					history,
				};
				writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
				return success(`exported ${scope} store (${Object.values(state.entries).reduce((n, e) => n + Object.keys(e).length, 0)} entries, ${history.length} refinements) to ${path}`);
			}
			case "import": {
				const { scope, rest: after } = scopeArg(rest);
				const path = after[0];
				if (!path) {
					return error(`import requires an input path.\n${USAGE}`);
				}
				const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (!isValidExport(payload)) {
					return error(`invalid export file shape: expected {version, entries: {prompt, memory, skill, subagent}, refinements, history}`);
				}
				const state: HarnessState = {
					schema: typeof payload["schema"] === "number" ? payload["schema"] : 1,
					entries: {
						prompt: toEntryRecord(payload["entries"]["prompt"]),
						memory: toEntryRecord(payload["entries"]["memory"]),
						skill: toEntryRecord(payload["entries"]["skill"]),
						subagent: toEntryRecord(payload["entries"]["subagent"]),
					},
					refinements: Array.isArray(payload["refinements"]) ? (payload["refinements"] as HarnessState["refinements"]) : [],
				};
				const paths = storePaths(engine.baseDir, scope, storeIdForCommand(scope, invocation));
				saveHarnessState(paths.stateDir, state);
				if (Array.isArray(payload["history"])) {
					for (const result of payload["history"]) {
						if (isResultRecord(result)) {
							appendResult(paths, result);
						}
					}
					// Storage hygiene (#20): an imported history obeys the
					// same tail budget as a live one.
					try {
						pruneJsonlFile(paths.resultsPath, engine.retention?.refinements ?? DEFAULT_REFINEMENTS_RETAIN);
					} catch {
						// ignored — the next apply retries
					}
				}
				return success(`imported ${scope} store from ${path}`);
			}
			case "plan": {
				const { scope, rest: after } = scopeArg(rest);
				const instructions = after.length > 0 ? after.join(" ") : undefined;
				const state = engine.load(scope, storeIdForCommand(scope, invocation));
				const history = engine.history(scope, storeIdForCommand(scope, invocation));
				const proposal = await planWithLlm(ctx, {
					agent: invocation.agent,
					state,
					history,
					...(instructions ? { instructions } : {}),
					global: scope === "global",
					signal: invocation.signal,
					tokenUsage: {
						baseDir: engine.baseDir,
						sessionId,
						retain: engine.retention.tokenUsage,
						onError: (cause: unknown) =>
							ctx.logger("continual-evolve").warn(`token-usage ledger failed for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`),
					},
					// skill-creator template facts (fallback: builtin guide).
					skillsRoot: join(engine.baseDir, "skills"),
				});
				if ((scope === "global" || scope === "project") && opts.requireGlobalApproval && proposal.edits.length > 0) {
					await requireGlobalApproval(
						ctx,
						invocation.agent,
						invocation.signal,
						`/evolve plan ${scope} 将应用 ${proposal.edits.length} 条编辑到${scope === "project" ? "本项目" : "跨会话"} store：${proposal.summary}`,
					);
				}
				const result = engine.apply(scope, storeIdForCommand(scope, invocation), proposal, {
					scope,
					baselineState: state,
					...(entrySourceOf(invocation.agent, sessionId) ? { source: entrySourceOf(invocation.agent, sessionId) } : {}),
				});
				return success(renderResult(result));
			}
			case "wrapup": {
				return await executeWrapupCommand(ctx, engine, invocation, runtime.promotionPolicy);
			}
			case "pause":
			case "resume": {
				// #21 P2 runtime switch: pause the AUTOMATIC gate only. Manual
				// evolve_* tools and /evolve commands keep working — the human
				// is acting explicitly there, so no gate is being bypassed.
				const pausing = sub === "pause";
				const current = loadGateRuntime(engine.baseDir);
				if (current.paused === pausing) {
					return success(`auto-review gate is already ${pausing ? "paused" : "running"} (no change).`);
				}
				saveGateRuntime(engine.baseDir, pausing);
				return success(
					pausing
						? "auto-review gate paused: no automatic reviews, fate assessments, or gate LLM calls until /evolve resume. Manual evolve_* tools and /evolve commands keep working."
						: "auto-review gate resumed: automatic reviews run again on their configured cadence.",
				);
			}
			case "status": {
				return success(renderGateStatus(engine, sessionId, projectKeyOf(invocation.agent), runtime));
			}
			case "usage": {
				return success(renderUsageReport(engine, sessionId, projectKeyOf(invocation.agent)));
			}
			case "goal": {
				return executeGoalCommand(ctx, invocation, rest);
			}
			case "mount": {
				return await executeMountCommand(ctx, engine, invocation, rest);
			}
			case "unmount": {
				return await executeUnmountCommand(ctx, engine, rest);
			}
			case "benchmark": {
				return await executeBenchmarkCommand(ctx, engine, invocation, rest, runtime);
			}
			default:
				return error(`unknown subcommand: ${sub}\n${USAGE}`);
		}
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

/**
 * Demote (2026-08-22): hide an entry from injection WITHOUT deleting it —
 * the one-command remedy for store pollution. Searches the global store
 * first (the primary target: cross-project noise), then the project store,
 * then the session's local store. The data stays; `/evolve unarchive` restores it.
 */
function demoteEntry(engine: EvolutionEngine, id: string, sessionId: string, projectKey?: string): CommandResult {
	const targets: { scope: HarnessScope; storeId: string | undefined }[] = [
		{ scope: "global", storeId: undefined },
		...(projectKey ? [{ scope: "project" as const, storeId: projectKey }] : []),
		{ scope: "local", storeId: sessionId },
	];
	for (const { scope, storeId } of targets) {
		const state = engine.load(scope, storeId);
		const found = findEntryById(state, id);
		if (!found) continue;
		const [kind, entry] = found;
		const result = engine.apply(
			scope,
			storeId,
			{
				summary: `demote: archive ${kind}:${id} from the ${scope} store`,
				rationale: "Human-invoked demote via the /evolve command.",
				expectedOutcome: "The entry is hidden from injection in every scope it touched; data is kept and restorable.",
				edits: [
					{
						action: "update",
						kind,
						id,
						title: entry.title,
						content: entry.content,
						metadata: { ...entry.metadata, [ARCHIVED_AT_KEY]: new Date().toISOString() },
					},
				],
			},
			{ scope },
		);
		const restoreScope = scope === "global" ? " global" : scope === "project" ? " project" : "";
		return success(`demoted ${kind}:${id} from the ${scope} store (archived — restore with /evolve unarchive ${id}${restoreScope})\n${renderResult(result)}`);
	}
	return error(`entry ${id} not found in the global, project, or local store`);
}

/**
 * #21 status: one screen answering "is the gate on, and what is in the
 * stores". The patch flag says whether the gate was registered at boot;
 * the runtime switch says whether the human paused it since.
 */
function renderGateStatus(engine: EvolutionEngine, sessionId: string, projectKey: string | undefined, runtime: CommandRuntimeOptions): string {
	const paused = loadGateRuntime(engine.baseDir).paused;
	const patch = runtime.autoReview === undefined ? "unknown" : runtime.autoReview ? "on" : "off";
	const gateLine =
		patch === "off"
			? "gate: disabled in patch config (autoReview off — /evolve pause has nothing to pause)"
			: `gate: ${patch === "unknown" ? "patch flag unknown" : "enabled in patch config"} · ${paused ? "PAUSED by /evolve pause (resume with /evolve resume)" : "running"}`;
	const countEntries = (state: HarnessState): number => Object.values(state.entries).reduce((n, byKind) => n + Object.keys(byKind).length, 0);
	const lines = [gateLine];
	lines.push(`stores: global ${countEntries(engine.load("global", undefined))} entries · local(${sessionId}) ${countEntries(engine.load("local", sessionId))} entries`);
	if (projectKey) {
		try {
			lines[lines.length - 1] += ` · project ${countEntries(engine.load("project", projectKey))} entries`;
		} catch {
			lines[lines.length - 1] += " · project (unavailable)";
		}
	}
	const retention = engine.retention;
	if (retention) {
		lines.push(
			`retention: snapshots ${retention.snapshots} · refinements ${retention.refinements} · reviews ${retention.reviews} · token usage ${retention.tokenUsage} (historyRetain)`,
		);
	}
	return lines.join("\n");
}

/**
 * #21 P0 usage ledger: injection counts per entry across the stores the
 * human can see (global + this session + this project). Counts are
 * per-session since the v2 usage shape — "in how many sessions did this
 * entry surface" — the exposure half of the #18a归零实验 verdict.
 */
function renderUsageReport(engine: EvolutionEngine, sessionId: string, projectKey: string | undefined): string {
	const store = loadUsage(engine.baseDir);
	const rows: { key: string; title: string; count: number; lastSession?: string }[] = [];
	const seen = new Set<string>();
	const collect = (state: HarnessState): void => {
		for (const kind of Object.keys(state.entries) as RefinementKind[]) {
			for (const entry of Object.values(state.entries[kind])) {
				const key = `${kind}:${entry.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const count = getUsageCount(store, kind, entry.id);
				rows.push({
					key,
					title: entry.title,
					count,
					...(store.lastSession?.[`${kind}:${entry.id}`] ? { lastSession: store.lastSession[`${kind}:${entry.id}`] } : {}),
				});
			}
		}
	};
	collect(engine.load("global", undefined));
	collect(engine.load("local", sessionId));
	if (projectKey) {
		try {
			collect(engine.load("project", projectKey));
		} catch {
			// project store unavailable here — global+local still report
		}
	}
	const liveKeys = new Set(rows.map((r) => r.key));
	const orphaned = Object.keys(store.counts).filter((k) => !liveKeys.has(k)).length;
	const total = rows.reduce((n, r) => n + r.count, 0);
	const injected = rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
	const stale = rows.filter((r) => r.count === 0).sort((a, b) => (a.key < b.key ? -1 : 1));
	const lines = [`injected entries: ${total} injections across ${injected.length} of ${rows.length} stored entries${orphaned > 0 ? ` (+${orphaned} historical key(s) for deleted entries)` : ""}`];
	if (injected.length > 0) {
		lines.push("injected (top 15):");
		for (const row of injected.slice(0, 15)) {
			lines.push(`  ${row.key} — ${row.count}× · ${row.title}${row.lastSession ? ` (last in ${row.lastSession})` : ""}`);
		}
		if (injected.length > 15) {
			lines.push(`  … and ${injected.length - 15} more`);
		}
	} else {
		lines.push("injected: (none yet — nothing has surfaced into a session prompt)");
	}
	if (stale.length > 0) {
		lines.push(`never injected (${stale.length}):`);
		for (const row of stale.slice(0, 20)) {
			lines.push(`  ${row.key} · ${row.title}`);
		}
		if (stale.length > 20) {
			lines.push(`  … and ${stale.length - 20} more`);
		}
	}
	lines.push("", ...renderTokenUsageReport(loadTokenUsage(engine.baseDir), engine.retention.tokenUsage));
	return lines.join("\n");
}

function renderResult(result: RefinementResult): string {	const applied = result.appliedEdits.filter((e) => e.applied);
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

function toEntryRecord(value: unknown): Record<string, HarnessEntry> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, HarnessEntry>;
}

function parsePositiveInt(value: string, what: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${what} must be a positive integer, got "${value}"`);
	}
	return n;
}

function isValidExport(payload: Record<string, unknown>): payload is { entries: Record<string, Record<string, unknown>>; refinements: unknown; history: unknown; schema: unknown } {
	if (typeof payload !== "object" || payload === null) return false;
	const entries = payload["entries"];
	if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return false;
	const kinds = ["prompt", "memory", "skill", "subagent"];
	return kinds.every((kind) => Object.prototype.hasOwnProperty.call(entries, kind));
}

function isResultRecord(value: unknown): boolean {
	return typeof value === "object" && value !== null && "id" in value && "appliedEdits" in value;
}

function success(text: string): CommandResult {
	return { kind: "success", text };
}

function error(text: string): CommandResult {
	return { kind: "error", text };
}
