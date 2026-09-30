#!/usr/bin/env -S ../node_modules/.bin/tsx
/**
 * Gate aggregator (DSH run-gates shape): one entry for docs/governance gates.
 *
 * Usage:
 *   tsx scripts/run-gates.ts docs   # adr-format + doc-budgets + md-links + governance
 *   tsx scripts/run-gates.ts all    # docs (CI owns typecheck/lint/test/coverage separately)
 */
import { spawnSync } from "node:child_process";

const MODES = ["docs", "all"] as const;
type Mode = (typeof MODES)[number];

function run(label: string, args: string[], cmd = process.execPath): void {
	console.log(`== gate: ${label} ==`);
	// 非 node 门禁（python3）直接以给定命令运行；node 门禁经 tsx（沙箱 /home 只读下 pnpm 直跑会炸，直调语义等价）。
	const r = spawnSync(cmd, cmd === process.execPath ? ["./node_modules/tsx/dist/cli.mjs", ...args] : args, { stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`gate FAILED: ${label}`);
		process.exit(r.status ?? 1);
	}
}

function main(): void {
	const mode = (process.argv[2] ?? "docs") as Mode;
	if (!MODES.includes(mode)) {
		console.error(`run-gates: expected mode ${MODES.join(" | ")}, got ${JSON.stringify(mode)}`);
		process.exit(1);
	}
	run("verify-adr-format", ["scripts/verify-adr-format.ts"]);
	run("verify-doc-budgets", ["scripts/verify-doc-budgets.ts", "--manifest", "scripts/doc-budgets.manifest.json"]);
	run("verify-md-links", ["scripts/verify-md-links.ts"]);
	run("verify-governance", ["scripts/verify-governance.ts"]);
	// 工作区根 HANDOFF 家庭（入口/待办/冷归档）：干净检出下文件缺席即跳过（clean-CI 语义）
	run("verify-handoff-structure", ["scripts/verify-handoff-structure.py"], "python3");
	console.log("run-gates OK");
}

main();
