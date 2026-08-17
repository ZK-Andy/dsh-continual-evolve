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
import type { QuestionService } from "./approval.js";
import { assessLocalEntries, candidateKey, filterPromotable, listLocalCandidates, splitArchiveGuards, splitPromoteBlocked, splitPromoteProposals, wholePromoteProposals } from "./wrapup.js";
import type { WrapupCandidate, WrapupItem } from "./wrapup.js";
import { saveHarnessState } from "./state.js";
import { loadLedger, mountSkill, unmountSkill } from "./mount.js";
import { blockEvolutionGoal, completeEvolutionGoal, goalServiceOf, goalStatusText, upsertEvolutionGoal } from "./goal.js";
import { appendResult, storePaths } from "./store.js";
import { addCase, createBenchmark, listBenchmarks, listCases, loadBenchmark, loadScoreboard, rollbackRejectedCandidate, saveScoreboard } from "./benchmark.js";
import { decide, decisionReport, entryFromCells } from "./score.js";
import { evaluateState } from "./evaluate.js";
import { entrySourceOf } from "./source.js";
import { filterLogBySession, formatLogLine, pluginLogFilePath } from "./logfile.js";

const USAGE = `Usage:
  /evolve                  show this help and the current local store
  /evolve list [global]    list entries (add "global" for the cross-session store)
  /evolve history [global] show applied refinements (rollback ids)
  /evolve rollback <id> [global]  deterministically revert a refinement
  /evolve plan [msg]       run the LLM planner against the current store
  /evolve wrapup           assess this session's local entries: promote reusable ones
                           to the global store (approval required), archive one-offs
  /evolve archive <id> [global]   hide an entry from injection (data kept, restorable)
  /evolve unarchive <id> [global] restore an archived entry
  /evolve log [tail N]            show the recent plugin log (default 50 lines)
  /evolve export [global] <path>  backup a store to a JSON file
  /evolve import [global] <path>  restore a store from an export file
  /evolve mount <skillId>    hot-mount a skill entry as a live cordis plugin
  /evolve mount list         list hot-mounted plugins
  /evolve unmount <id>       remove a hot-mounted plugin
  /evolve goal               show the evolution goal (round-driven auto-review)
  /evolve goal <objective>   create/update the evolution goal
  /evolve goal done          complete the evolution goal`;

export interface CommandGateOptions {
	requireGlobalApproval: boolean;
}

export interface CommandRuntimeOptions {
	rubricKey: Buffer;
	/** When a benchmark decision rejects a candidate, roll the refinement back automatically. */
	autoRollbackOnReject: boolean;
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
	return { scope: "local", rest: tokens };
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
				return success(formatHarnessStateForPrompt(engine.load(scope, sessionId)));
			}
			case "history": {
				const { scope } = scopeArg(rest);
				const history = engine.history(scope, sessionId);
				return success(historyForPrompt(history) || "(no refinements yet)");
			}
			case "rollback": {
				const { scope, rest: after } = scopeArg(rest);
				const id = stripAngleBrackets(after[0] ?? "");
				if (!id) {
					return error(`rollback requires a refinement id.\n${USAGE}`);
				}
				const result = engine.rollback(scope, sessionId, id);
				return success(renderResult(result));
			}
			case "archive":
			case "unarchive": {
				const { scope, rest: after } = scopeArg(rest);
				const id = stripAngleBrackets(after[0] ?? "");
				if (!id) {
					return error(`${sub} requires an entry id.\n${USAGE}`);
				}
				const state = engine.load(scope, sessionId);
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
					sessionId,
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
				const state = engine.load(scope, sessionId);
				const history = engine.history(scope, sessionId);
				const payload = {
					version: 1,
					scope,
					schema: state.schema,
					entries: state.entries,
					refinements: state.refinements,
					history,
				};
				writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
				const paths = storePaths(engine.baseDir, scope, sessionId);
				saveHarnessState(paths.stateDir, state);
				if (Array.isArray(payload["history"])) {
					for (const result of payload["history"]) {
						if (isResultRecord(result)) {
							appendResult(paths, result);
						}
					}
				}
				return success(`imported ${scope} store from ${path}`);
			}
			case "plan": {
				const { scope, rest: after } = scopeArg(rest);
				const instructions = after.length > 0 ? after.join(" ") : undefined;
				const state = engine.load(scope, sessionId);
				const history = engine.history(scope, sessionId);
				const proposal = await planWithLlm(ctx, {
					agent: invocation.agent,
					state,
					history,
					...(instructions ? { instructions } : {}),
					global: scope === "global",
					signal: invocation.signal,
					// skill-creator template facts (fallback: builtin guide).
					skillsRoot: join(engine.baseDir, "skills"),
				});
				if (scope === "global" && opts.requireGlobalApproval && proposal.edits.length > 0) {
					await requireGlobalApproval(
						ctx,
						invocation.agent,
						invocation.signal,
						`/evolve plan global 将应用 ${proposal.edits.length} 条编辑到跨会话 store：${proposal.summary}`,
					);
				}
				const result = engine.apply(scope, sessionId, proposal, {
					scope,
					baselineState: state,
					...(entrySourceOf(invocation.agent, sessionId) ? { source: entrySourceOf(invocation.agent, sessionId) } : {}),
				});
				return success(renderResult(result));
			}
			case "wrapup": {
				return await executeWrapupCommand(ctx, engine, invocation);
			}
			case "goal": {
				return executeGoalCommand(ctx, invocation, rest);
			}
			case "mount": {
				return executeMountCommand(ctx, engine, invocation, rest);
			}
			case "unmount": {
				const id = stripAngleBrackets(rest[0] ?? "");
				if (!id) {
					return error(`unmount requires a mount id (see /evolve mount list).`);
				}
				const record = await unmountSkill(ctx, engine.baseDir, id);
				return record ? success(`unmounted ${record.id} (${record.entryId})`) : error(`no mount found for ${id}`);
			}
			case "benchmark": {
				return executeBenchmarkCommand(ctx, engine, invocation, rest, runtime);
			}
			default:
				return error(`unknown subcommand: ${sub}\n${USAGE}`);
		}
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

function executeGoalCommand(ctx: Context, invocation: CommandInvocation, rest: string[]): CommandResult {
	const agent = invocation.agent;
	const goals = goalServiceOf(ctx);
	if (!goals) {
		return error(`/evolve goal requires the goals service (load @deepseek-ai/dsh-goal)`);
	}
	const sub = rest[0] ?? "";
	try {
		if (sub === "done") {
			const view = completeEvolutionGoal(ctx, agent);
			return view ? success(`evolution goal completed: ${goalStatusText(view)}`) : success("(no goal to complete)");
		}
		if (sub === "block") {
			const reason = rest.slice(1).join(" ") || "user requested block";
			const view = blockEvolutionGoal(ctx, agent, reason);
			return view ? success(`evolution goal blocked: ${goalStatusText(view)}`) : success("(no active goal to block)");
		}
		if (sub.length === 0) {
			const current = goals.get(agent);
			return current ? success(goalStatusText(current)) : success("(no evolution goal — /evolve goal <objective> to create one)");
		}
		const objective = rest.join(" ");
		const view = upsertEvolutionGoal(ctx, agent, objective);
		return success(`evolution goal ready: ${goalStatusText(view)}\n(active goal drives the review gate every round)`);
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

async function executeWrapupCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
): Promise<CommandResult> {
	const sessionId = invocation.agent.id;
	const localState = engine.load("local", sessionId);
	const globalState = engine.load("global", undefined);
	const candidates = listLocalCandidates(localState, globalState);
	if (candidates.length === 0) {
		return success(
			`(nothing to wrap up: ${sessionId}'s local store has no active, un-promoted entries — use /evolve list to inspect it)`,
		);
	}

	// 1. Classify: the model judges each audited candidate's fate.
	const assessment = await assessLocalEntries(ctx, invocation.agent, candidates, { signal: invocation.signal });
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));

	// 2. Partition by action. Deterministic guards re-check the LIVE global
	//    store right before anything lands (state may have changed mid-call).
	const { promotable, skipped } = filterPromotable(assessment.items, globalState, candidates);
	const promoteItems = promotable.filter((item) => item.verdict === "promote");
	const archiveItems = assessment.items.filter((item) => item.verdict === "archive");
	// Split promotion (A-form): archive a mixed entry but promote ONLY the
	// cleaned durable part the model extracted. Guarded the same way as whole
	// promotes — a split that would duplicate a globally covered topic is
	// dropped and the entry archives plain.
	const splitItems: { item: WrapupItem; candidate: WrapupCandidate }[] = [];
	const splitSkipped: { key: string; reason: string }[] = [];
	for (const item of archiveItems) {
		if (!item.promote) continue;
		const candidate = byKey.get(item.key);
		if (!candidate) {
			splitSkipped.push({ key: item.key, reason: "not in the audited candidate list" });
			continue;
		}
		const blocked = splitPromoteBlocked(item, globalState, candidate.kind);
		if (blocked) {
			splitSkipped.push({ key: item.key, reason: blocked });
			continue;
		}
		splitItems.push({ item, candidate });
	}
	// Plain archives (no split payload): the symmetric guard — an archive that
	// is NOT globally covered AND was distilled from real user messages must
	// not proceed silently.
	const plainArchives = archiveItems.filter((item) => !item.promote);
	const { silent: silentArchives, review: reviewArchives } = splitArchiveGuards(plainArchives, candidates);
	const keepItems = assessment.items.filter((item) => item.verdict === "keep");

	// 3. Report the assessment before touching anything.
	const lines: string[] = [
		`wrapup assessment (${sessionId}): ${candidates.length} candidates${candidates.some((c) => c.coveredGlobally) ? `, ${candidates.filter((c) => c.coveredGlobally).length} covered globally` : ""}`,
		`${assessment.rationale}`,
	];
	for (const [heading, items] of [
		["PROMOTE (to global)", promoteItems],
		["SPLIT (archive + promote durable part)", splitItems.map((split) => split.item)],
		["ARCHIVE", silentArchives],
		["ARCHIVE (needs review)", reviewArchives],
		["KEEP", keepItems],
	] as const) {
		lines.push(`${heading}: ${items.length}`);
		for (const item of items) {
			const candidate = byKey.get(item.key);
			const title = candidate ? candidate.title : item.key;
			const splitNote = item.promote ? ` → 拆出提升「${item.promote.title}」` : "";
			lines.push(`- ${item.key} "${title}"${splitNote} — ${item.reason}`);
		}
	}
	for (const skip of skipped) {
		lines.push(`- promote skipped: ${skip.key} — ${skip.reason}`);
	}
	for (const skip of splitSkipped) {
		lines.push(`- split skipped: ${skip.key} — ${skip.reason}`);
	}
	lines.push("");

	const applied: string[] = [];

	// 4. Global writes: governed resource — ONE human approval gate covers
	//    every create (whole promotes AND split promotions). On approval:
	//    - whole promote → create global copy + stamp local promotedTo+archivedAt;
	//    - split → create the cleaned durable part + archive the original with
	//      promotedTo. On rejection: whole promotes are not written, and each
	//      split's original STILL archives plain (its snapshot half deserves
	//      the archive; the durable half is reported for manual handling).
	const wholeCreates = promoteItems.map((item) => ({ item, candidate: byKey.get(item.key) }));
	const splitCreates = splitItems;
	const allCreates = new Set([...wholeCreates.map((c) => c.item.key), ...splitCreates.map((c) => c.item.key)]);
	if (allCreates.size > 0) {
		const what = `wrapup 将写入跨会话 global store（共 ${allCreates.size} 条：${promoteItems.length} 条整条提升 + ${splitItems.length} 条拆解提升）：\n${[
			...promoteItems.map((item) => `- 整条提升 ${item.key} "${byKey.get(item.key)?.title ?? item.key}"`),
			...splitItems.map(
				(split) => `- 拆解提升 ${split.item.key} → 清洗「${split.item.promote?.title}」（原条目随之归档）`,
			),
		].join("\n")}`;
		let promoteAllowed = true;
		try {
			await requireGlobalApproval(ctx, invocation.agent, invocation.signal, what);
		} catch (cause) {
			promoteAllowed = false;
			const message = `global 写入未批准 — 整条提升与拆解提升均未写入 (${cause instanceof Error ? cause.message : String(cause)})`;
			applied.push(message);
			lines.push(message);
		}
		if (promoteAllowed) {
			// Whole promotes: create global entry, retire the local copy.
			// Shared proposal builders keep the wrap-up command and the gate's
			// local-fate dimension writing IDENTICAL edits.
			for (const { item, candidate } of wholeCreates) {
				if (!candidate) continue;
				const proposals = wholePromoteProposals(item, candidate, sessionId);
				const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
				const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
				const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
					scope: "local",
					baselineState: localState,
				});
				applied.push(`promoted ${item.key} → global:${createdId} (${globalResult.id}; local stamped ${localResult.id})`);
			}
			// Split promotions: create the cleaned durable part, retire the
			// original local entry (its snapshot half is archived along).
			for (const { item, candidate } of splitCreates) {
				if (!item.promote) continue;
				const proposals = splitPromoteProposals(item, candidate, sessionId);
				const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
				const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
				const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
					scope: "local",
					baselineState: localState,
				});
				applied.push(`split ${item.key}: promoted cleaned part → global:${createdId} (${globalResult.id}); original archived (${localResult.id})`);
			}
		} else {
			// Rejected: whole promotes stay un-written; each split's original
			// still archives plain (reported, data restorable).
			for (const { item, candidate } of splitCreates) {
				if (!candidate) continue;
				const result = engine.apply(
					"local",
					sessionId,
					{
						summary: `wrapup: split promotion not approved — archive original ${item.key} plain`,
						rationale: item.reason,
						expectedOutcome: `The original leaves injection; the cleaned part was NOT written (reported for manual handling).`,
						edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
					},
					{ scope: "local", baselineState: localState },
				);
				applied.push(`split ${item.key}: promotion not approved — original archived plain (${result.id})`);
			}
		}
	}
	// 5. Silent archives: deterministic local action (hidden from injection,
	//    data kept restorable) — covered topics and operational entries need no
	//    confirmation, matching the original behavior.
	for (const item of silentArchives) {
		const candidate = byKey.get(item.key);
		if (!candidate) continue;
		const result = engine.apply(
			"local",
			sessionId,
			{
				summary: `wrapup: archive local ${item.key} — ${item.reason}`,
				rationale: item.reason,
				expectedOutcome: `The entry stops being injected but stays restorable.`,
				edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
			},
			{ scope: "local", baselineState: localState },
		);
		applied.push(`archived ${item.key} (${result.id})`);
	}

	// 6. Review archives (symmetric guard): not covered globally + distilled
	//    from real user messages — the user decides before this content is
	//    hidden from future sessions. No question service → conservative keep.
	const userQuestions = (ctx as unknown as { userQuestions?: QuestionService }).userQuestions;
	for (const item of reviewArchives) {
		const candidate = byKey.get(item.key);
		if (!candidate) continue;
		if (!userQuestions) {
			applied.push(`kept ${item.key} — archive pending user confirmation (no question service)`);
			continue;
		}
		const questionId = "evolve-wrapup-archive-review";
		let archiveConfirmed = false;
		try {
			const answer = await userQuestions.ask({
				questions: [
					{
						id: questionId,
						question: `wrapup：条目「${candidate.title}」未被全局覆盖且源自真实对话，直接归档会隐藏它（数据保留、可恢复）。确认归档？`,
						options: [{ label: "归档" }, { label: "保留" }],
					},
				],
				agent: invocation.agent,
				signal: invocation.signal,
			});
			archiveConfirmed = answer.answers?.find((entry) => entry.id === questionId)?.selected?.includes("归档") ?? false;
		} catch {
			archiveConfirmed = false;
		}
		if (archiveConfirmed) {
			const result = engine.apply(
				"local",
				sessionId,
				{
					summary: `wrapup: archive local ${item.key} (user-confirmed) — ${item.reason}`,
					rationale: item.reason,
					expectedOutcome: `The entry stops being injected but stays restorable.`,
					edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
				},
				{ scope: "local", baselineState: localState },
			);
			applied.push(`archived ${item.key} (user-confirmed, ${result.id})`);
		} else {
			applied.push(`kept ${item.key} — user declined the archive`);
		}
	}

	lines.push(...(applied.length > 0 ? applied : ["(no changes applied — all entries kept)"]));
	return success(lines.join("\n"));
}

async function executeMountCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	rest: string[],
): Promise<CommandResult> {
	const sub = rest[0] ?? "";
	if (sub === "list") {
		const ledger = loadLedger(engine.baseDir);
		if (ledger.mounted.length === 0) {
			return success("(no hot-mounted plugins — /evolve mount <skillId>)");
		}
		return success(ledger.mounted.map((m) => `- ${m.id} (${m.entryId}, v${m.version}, ${m.mountedAt})`).join("\n"));
	}
	const skillId = stripAngleBrackets(sub);
	if (!skillId) {
		return error(`mount requires a skill entry id.\nUsage: /evolve mount <skillId> | /evolve mount list`);
	}
	const sessionId = invocation.agent.id;
	const local = engine.load("local", sessionId);
	const globalState = engine.load("global", undefined);
	const entry =
		local.entries.skill[skillId] ??
		globalState.entries.skill[skillId] ??
		Object.values(local.entries.skill).find((e) => e.id === skillId) ??
		Object.values(globalState.entries.skill).find((e) => e.id === skillId);
	if (!entry) {
		return error(`skill entry ${skillId} not found in local or global store`);
	}
	try {
		const record = await mountSkill(ctx, engine.baseDir, entry);
		return success(`mounted ${record.id} as ${record.entryId} (v${record.version}) — tool: skill_${record.id.replace(/_/g, "-")}`);
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

async function executeBenchmarkCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	rest: string[],
	runtime: CommandRuntimeOptions,
): Promise<CommandResult> {
	const sub = rest[0] ?? "";
	const args = rest.slice(1);
	const sessionId = invocation.agent.id;
	const baseDir = engine.baseDir;

	switch (sub) {
		case "":
		case "help":
			return success(BENCHMARK_USAGE);
		case "new": {
			const title = args[0] ?? "";
			if (!title) {
				return error(`benchmark new requires a title.\n${BENCHMARK_USAGE}`);
			}
			const runs = args[1] !== undefined ? parsePositiveInt(args[1], "runs") : undefined;
			const definition = createBenchmark(baseDir, { title, ...(runs !== undefined ? { runs } : {}) });
			return success(
				`benchmark ${definition.id} created (runs=${definition.runs}, passThreshold=${definition.passThreshold})\nAdd cases with: /evolve benchmark add-case ${definition.id} "<title>" "<statement>" "<rubric>"`,
			);
		}
		case "list": {
			const benchmarks = listBenchmarks(baseDir);
			if (benchmarks.length === 0) {
				return success("(no benchmarks yet — use /evolve benchmark new <title>)");
			}
			const lines = benchmarks.map((b) => {
				const cases = listCases(baseDir, b.id);
				const board = loadScoreboard(baseDir, b.id);
				const ref = board.reference ? ` ref=${board.reference.overall ?? "?"}` : " no-reference";
				return `- ${b.id} (${cases.length} cases, runs=${b.runs})${ref}`;
			});
			return success(lines.join("\n"));
		}
		case "add-case": {
			const bid = stripAngleBrackets(args[0] ?? "");
			const title = args[1] ?? "";
			const statement = args[2] ?? "";
			const rubric = args[3] ?? "";
			if (!bid || !title || !statement || !rubric) {
				return error(`benchmark add-case needs <bid> <title> <statement> <rubric>.\n${BENCHMARK_USAGE}`);
			}
			const caseItem = addCase(baseDir, bid, title, statement, rubric, runtime.rubricKey);
			return success(`case ${caseItem.id} added to ${bid}`);
		}
		case "reset": {
			const bid = stripAngleBrackets(args[0] ?? "");
			if (!bid) {
				return error(`benchmark reset needs a <bid>.\n${BENCHMARK_USAGE}`);
			}
			if (!loadBenchmark(baseDir, bid)) {
				return error(`benchmark ${bid} not found`);
			}
			saveScoreboard(baseDir, bid, { candidates: [], decisions: [] });
			return success(`scoreboard reset for ${bid} — run /evolve benchmark run ${bid} to record a fresh reference`);
		}
		case "status": {
			const bid = stripAngleBrackets(args[0] ?? "");
			const board = loadScoreboard(baseDir, bid);
			const lines: string[] = [];
			if (board.reference) {
				lines.push(`reference "${board.reference.label}": overall=${board.reference.overall ?? "?"} cells=${board.reference.cells.length}`);
			} else {
				lines.push("(no reference evaluation yet)");
			}
			for (const c of board.candidates) {
				lines.push(`candidate "${c.label}": overall=${c.overall ?? "?"} cells=${c.cells.length}${c.refinementId ? ` (${c.refinementId})` : ""}`);
			}
			for (const d of board.decisions) {
				lines.push(`decision: ${d.accepted ? "ACCEPTED" : "rejected"} ${d.candidateLabel} — ${d.reasons.join("; ") || "ok"}`);
			}
			return success(lines.join("\n") || "(empty scoreboard)");
		}
		case "run": {
			const bid = stripAngleBrackets(args[0] ?? "");
			const candidateId = args.includes("candidate") ? stripAngleBrackets(args[args.indexOf("candidate") + 1] ?? "") : undefined;
			const definition = loadBenchmark(baseDir, bid);
			if (!definition) {
				return error(`benchmark ${bid} not found`);
			}
			const cases = listCases(baseDir, bid);
			if (cases.length === 0) {
				return error(`benchmark ${bid} has no cases — use /evolve benchmark add-case`);
			}
			const board = loadScoreboard(baseDir, bid);
			const label = candidateId ? `candidate:${candidateId}` : "reference";
			if (!candidateId && board.reference) {
				return error(`reference already evaluated (${board.reference.overall ?? "?"}); evaluate a candidate instead: /evolve benchmark run ${bid} candidate <refinementId>`);
			}
			const overview = formatHarnessStateForPrompt(engine.load("local", sessionId));
			const outcome = await evaluateState(ctx, invocation.agent, {
				cases,
				rubricKey: runtime.rubricKey,
				runs: definition.runs,
				passThreshold: definition.passThreshold,
				harnessOverview: overview,
				label,
				signal: invocation.signal,
			});
			const entry = entryFromCells(label, outcome.cells, candidateId);
			const lines = [
				`evaluation "${label}": ${outcome.cells.length} cells, overall=${entry.overall ?? "?"}`,
				...Object.entries(entry.aggregate)
					.filter(([key]) => key !== "overall")
					.map(([key, value]) => `  ${key}: ${value ?? "?"}`),
			];
			if (candidateId) {
				if (!board.reference) {
					lines.push("(no reference yet — this run only recorded the candidate)");
					board.candidates.push(entry);
				} else {
					const decision = decide(board.reference, entry, { passThreshold: definition.passThreshold, regressionTolerance: 0 });
					board.candidates.push(entry);
					board.decisions.push({
						candidateLabel: label,
						refinementId: candidateId,
						accepted: decision.accepted,
						reasons: decision.reasons,
						createdAt: new Date().toISOString(),
					});
					lines.push(...decisionReport(board.reference, entry, decision));
					if (!decision.accepted) {
						lines.push(`Consider rolling back the candidate: /evolve rollback <${candidateId}>`);
						if (runtime.autoRollbackOnReject) {
							const outcome = rollbackRejectedCandidate(engine, sessionId, candidateId);
							lines.push(outcome.message);
						}
					}
				}
			} else {
				board.reference = entry;
				lines.push("reference evaluation recorded as the baseline");
			}
			saveScoreboard(baseDir, bid, board);
			return success(lines.join("\n"));
		}
		default:
			return error(`unknown benchmark subcommand: ${sub}\n${BENCHMARK_USAGE}`);
	}
}

const BENCHMARK_USAGE = `Usage:
  /evolve benchmark new <title>                          create a benchmark (runs=1)
  /evolve benchmark add-case <bid> <title> <statement> <rubric>
  /evolve benchmark list                                 list benchmarks + reference status
  /evolve benchmark status <bid>                         show scoreboard + decisions
  /evolve benchmark reset <bid>                          clear the scoreboard (fresh reference)
  /evolve benchmark run <bid>                            evaluate current state as the reference
  /evolve benchmark run <bid> candidate <refinementId>   evaluate the post-refinement state and decide`;

function renderResult(result: RefinementResult): string {
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
