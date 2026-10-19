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

function run(label: string, args: string[]): void {
	console.log(`== gate: ${label} ==`);
	const r = spawnSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", ...args], { stdio: "inherit" });
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
	run("verify-src-budgets", ["scripts/verify-src-budgets.ts"]);
	run("verify-layering", ["scripts/verify-layering.ts"]);
	run("verify-schema-snapshot", ["scripts/verify-schema-snapshot.ts"]);
	run("verify-adr-coverage", ["scripts/verify-adr-coverage.ts"]);
	run("verify-dep-cycles", ["scripts/verify-dep-cycles.ts"]);
	run("verify-budget-ratchet", ["scripts/verify-budget-ratchet.ts"]);
	run("verify-layer-allowlist", ["scripts/verify-layer-allowlist.ts"]);
	run("verify-test-pairing", ["scripts/verify-test-pairing.ts"]);
	run("verify-api-snapshot", ["scripts/verify-api-snapshot.ts"]);
	run("verify-history-words", ["scripts/verify-history-words.ts"]);
	run("verify-adr-alternatives", ["scripts/verify-adr-alternatives.ts"]);
	run("verify-fn-shape", ["scripts/verify-fn-shape.ts"]);
	run("verify-review-tier", ["scripts/verify-review-tier.ts"]);
	run("verify-gate-fixtures", ["scripts/verify-gate-fixtures.ts"]);
	// 工作区根 HANDOFF 家庭（入口/待办/冷归档）：干净检出下文件缺席即跳过（clean-CI 语义）
	run("verify-handoff-structure", ["scripts/verify-handoff-structure.ts"]);
	console.log("run-gates OK");
}

main();
