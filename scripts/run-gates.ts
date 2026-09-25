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
	console.log("run-gates OK");
}

main();
