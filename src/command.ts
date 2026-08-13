/**
 * The human-facing `/evolve` command: inspect and drive the continual
 * harness from the chat UI without the model in between.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { HarnessScope, RefinementResult } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import { planWithLlm } from "./planner.js";
import { requireGlobalApproval } from "./approval.js";
import { addCase, createBenchmark, listBenchmarks, listCases, loadBenchmark, loadScoreboard, saveScoreboard } from "./benchmark.js";
import { decide, entryFromCells } from "./score.js";
import { evaluateState } from "./evaluate.js";

const USAGE = `Usage:
  /evolve                  show this help and the current local store
  /evolve list [global]    list entries (add "global" for the cross-session store)
  /evolve history [global] show applied refinements (rollback ids)
  /evolve rollback <id> [global]  deterministically revert a refinement
  /evolve plan [msg]       run the LLM planner against the current store`;

export interface CommandGateOptions {
	requireGlobalApproval: boolean;
}

export function registerEvolveCommand(ctx: Context, engine: EvolutionEngine, opts: CommandGateOptions): void {
	ctx.commands.register({
		name: "evolve",
		description: "inspect and evolve the continual harness state (memories, skills, prompt notes, subagent specs)",
		input: { hint: "[list [global] | history [global] | rollback <id> [global] | plan [msg]]" },
		handler: (invocation) => executeEvolveCommand(ctx, engine, invocation, opts),
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

async function executeEvolveCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	opts: CommandGateOptions,
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
				});
				if (scope === "global" && opts.requireGlobalApproval && proposal.edits.length > 0) {
					await requireGlobalApproval(
						ctx,
						invocation.agent,
						invocation.signal,
						`/evolve plan global 将应用 ${proposal.edits.length} 条编辑到跨会话 store：${proposal.summary}`,
					);
				}
				const result = engine.apply(scope, sessionId, proposal, { scope, baselineState: state });
				return success(renderResult(result));
			}
			case "benchmark": {
				return executeBenchmarkCommand(ctx, engine, invocation, rest);
			}
			default:
				return error(`unknown subcommand: ${sub}\n${USAGE}`);
		}
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

async function executeBenchmarkCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	rest: string[],
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
			const title = args.join(" ");
			if (!title) {
				return error(`benchmark new requires a title.\n${BENCHMARK_USAGE}`);
			}
			const definition = createBenchmark(baseDir, { title });
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
			const caseItem = addCase(baseDir, bid, title, statement, rubric);
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
					lines.push(
						decision.accepted
							? "DECISION: ACCEPTED — overall improved, no regression"
							: `DECISION: REJECTED — ${decision.reasons.join("; ")}`,
					);
					if (!decision.accepted) {
						lines.push(`Consider rolling back the candidate: /evolve rollback <${candidateId}>`);
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
		lines.push(`- ${e.action} ${e.kind}:${e.id} (v${e.after?.version ?? "?"})`);
	}
	for (const e of failed) {
		lines.push(`- failed ${e.action} ${e.kind}:${e.id ?? "(computed)"} — ${e.error ?? "unknown error"}`);
	}
	lines.push(`expected outcome: ${result.expectedOutcome}`);
	return lines.join("\n");
}

function success(text: string): CommandResult {
	return { kind: "success", text };
}

function error(text: string): CommandResult {
	return { kind: "error", text };
}
