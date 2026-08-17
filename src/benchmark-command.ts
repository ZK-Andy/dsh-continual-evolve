/**
 * The `/evolve benchmark` subcommand handler. Extracted from command.ts (P2-2).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { EvolutionEngine } from "./service.js";
import { formatHarnessStateForPrompt } from "./render.js";
import { stripAngleBrackets } from "./command.js";
import type { CommandRuntimeOptions } from "./command.js";
import { addCase, createBenchmark, listBenchmarks, listCases, loadBenchmark, loadScoreboard, rollbackRejectedCandidate, saveScoreboard } from "./benchmark.js";
import { decide, decisionReport, entryFromCells } from "./score.js";
import { evaluateState } from "./evaluate.js";

function success(text: string): CommandResult {
	return { kind: "success", text };
}

function error(text: string): CommandResult {
	return { kind: "error", text };
}

function parsePositiveInt(value: string, what: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${what} must be a positive integer, got "${value}"`);
	}
	return n;
}

/** " (N failed)" suffix when an evaluation entry carries failed cells. */
function failedTextOf(entry: { cells: { status: string }[] }): string {
	const failed = entry.cells.filter((cell) => cell.status === "failed").length;
	return failed > 0 ? ` (${failed} failed)` : "";
}

const BENCHMARK_USAGE = `Usage:
  /evolve benchmark new <title>                          create a benchmark (runs=1)
  /evolve benchmark add-case <bid> <title> <statement> <rubric>
  /evolve benchmark list                                 list benchmarks + reference status
  /evolve benchmark status <bid>                         show scoreboard + decisions
  /evolve benchmark reset <bid>                          clear the scoreboard (fresh reference)
  /evolve benchmark run <bid>                            evaluate current state as the reference
  /evolve benchmark run <bid> candidate <refinementId>   evaluate the post-refinement state and decide`;

export async function executeBenchmarkCommand(
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
				lines.push(`reference "${board.reference.label}": overall=${board.reference.overall ?? "?"} cells=${board.reference.cells.length}${failedTextOf(board.reference)}`);
			} else {
				lines.push("(no reference evaluation yet)");
			}
			for (const c of board.candidates) {
				lines.push(`candidate "${c.label}": overall=${c.overall ?? "?"} cells=${c.cells.length}${failedTextOf(c)}${c.refinementId ? ` (${c.refinementId})` : ""}`);
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
			const failedCells = outcome.cells.filter((cell) => cell.status === "failed").length;
			const lines = [
				`evaluation "${label}": ${outcome.cells.length} cells${failedCells > 0 ? `, ${failedCells} failed` : ""}, overall=${entry.overall ?? "?"}`,
				...Object.entries(entry.aggregate)
					.filter(([key]) => key !== "overall" && key !== "failed" && key !== "total")
					.map(([key, value]) => `  ${key}: ${value ?? "?"}`),
			];
			if (failedCells > 0) {
				for (const cell of outcome.cells.filter((cell) => cell.status === "failed")) {
					lines.push(`  [failed] ${cell.caseId} r${cell.run}: ${cell.notes}`);
				}
			}
			if (candidateId) {
				if (!board.reference) {
					lines.push("(no reference yet — this run only recorded the candidate)");
					board.candidates.push(entry);
				} else {
					const decision = decide(board.reference, entry, {
						passThreshold: definition.passThreshold,
						regressionTolerance: 0,
						maxFailedCells: 0,
					});
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
