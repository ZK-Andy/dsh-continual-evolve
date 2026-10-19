/**
 * The eval report builders (P5b): pure `report.json` + `compare.md`
 * construction over finished arm runs. Five task metrics plus the three
 * memory extras (`recall_hit` from the ledgers, conflict/repeat coverage
 * from tags) with lift against `base`; flaky items flagged, never averaged
 * away; judge-type QA reported apart per D10.
 */
import { EVAL_ARMS, type EvalArm } from "../data/records.js";

/** One task's finished record in one arm. */
export interface ArmTaskRecord {
	readonly id: string;
	readonly pass: boolean;
	readonly flaky: boolean;
	readonly rounds: number;
	readonly toolCalls: number;
	readonly cost: number;
	readonly recallHit: boolean | null;
	readonly note: string;
}

/** One arm's totals. */
export interface ArmTotals {
	readonly acc: number;
	readonly rounds: number;
	readonly toolCalls: number;
	readonly cost: number;
	readonly recallHits: number;
	readonly recallTotal: number;
}

/** One finished arm. */
export interface ArmResult {
	readonly arm: EvalArm;
	readonly tasks: ArmTaskRecord[];
	readonly totals: ArmTotals;
}

/** The batch report: four arms plus run identity. */
export interface CompareReport {
	readonly runId: string;
	readonly date: string;
	readonly commit: string;
	readonly taskCount: number;
	readonly arms: Record<EvalArm, ArmResult>;
	readonly flakyIds: string[];
	readonly budgetNote: string;
}

/**
 * Total one arm's task records.
 * @param arm - The arm the records belong to.
 * @param tasks - The finished task records.
 * @returns The arm result with averaged metrics.
 */
export function totalArm(arm: EvalArm, tasks: ArmTaskRecord[]): ArmResult {
	const n = tasks.length;
	const passed = tasks.filter((task) => task.pass).length;
	const recall = tasks.filter((task) => task.recallHit !== null);
	return {
		arm,
		tasks,
		totals: {
			acc: n === 0 ? 0 : passed / n,
			rounds: n === 0 ? 0 : tasks.reduce((sum, task) => sum + task.rounds, 0) / n,
			toolCalls: n === 0 ? 0 : tasks.reduce((sum, task) => sum + task.toolCalls, 0) / n,
			cost: tasks.reduce((sum, task) => sum + task.cost, 0),
			recallHits: recall.filter((task) => task.recallHit === true).length,
			recallTotal: recall.length,
		},
	};
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function liftOf(report: CompareReport, arm: EvalArm): string {
	const delta = report.arms[arm].totals.acc - report.arms.base.totals.acc;
	const sign = delta > 0 ? "+" : "";
	return `${sign}${pct(delta).replace("%", "pp")}`;
}

/**
 * Render the `compare.md` the freshness gate reads: header (run/commit/arms
 * verdict) plus the lift table and the flaky list.
 * @param report - The finished batch report.
 * @returns The markdown body.
 */
export function renderCompare(report: CompareReport): string {
	const head = `# 四臂对照 ${report.runId}\n\n- date: ${report.date}\n- commit: ${report.commit}\n- tasks: ${report.taskCount}\n- arms: ${EVAL_ARMS.join("/")}\n- 结论: base ${pct(report.arms.base.totals.acc)} / current ${pct(report.arms.current.totals.acc)}（lift ${liftOf(report, "current")}）/ candidate ${pct(report.arms.candidate.totals.acc)}（lift ${liftOf(report, "candidate")}）/ reflect ${pct(report.arms.reflect.totals.acc)}（lift ${liftOf(report, "reflect")}）\n`;
	const rows = EVAL_ARMS.map((arm) => {
		const totals = report.arms[arm].totals;
		return `| ${arm} | ${pct(totals.acc)} | ${totals.rounds.toFixed(2)} | ${totals.toolCalls.toFixed(2)} | ${totals.cost} | ${totals.recallHits}/${totals.recallTotal} |`;
	}).join("\n");
	const table = `\n| arm | acc | rounds | tool_calls | cost | recall_hit |\n|---|---|---|---|---|---|\n${rows}\n`;
	const flaky = report.flakyIds.length === 0
		? "\nflaky: 无\n"
		: `\nflaky: ${report.flakyIds.join(", ")}\n`;
	const budget = `\n预算: ${report.budgetNote}\n`;
	return `${head}${table}${flaky}${budget}`;
}
