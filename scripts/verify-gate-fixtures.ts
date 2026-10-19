#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify red-green fixtures for every gate (G3, the iron rule).
 *
 * Each `scripts/verify-*.ts` gate must pair with
 * `test/fixtures/gates/<gate-id>/{violation,clean}/`: the violation sample
 * must exit non-zero, the clean sample must exit zero. A gate without
 * fixtures — or one whose violation sample passes — is counted as
 * "unimplemented" and fails this gate.
 *
 * Provenance (backlog G3, total plan P0): the 2026-10-18 governance
 * shell-injection accident (a check that always exited 0 and never ran).
 * Order matters — violation first: a gate that is green on both is fake.
 *
 * Self-scope: this gate itself is NOT in the matrix (checking it would
 * recurse). Its own red/green is proven by `test/gate-fixtures.test.ts`
 * (matrix covers every other gate, fixtures exist) plus the sabotage check
 * in the acceptance run (comment out any gate logic → this gate turns red).
 * `schema-snapshot` has no static fixtures: its clean sample is generated
 * at runtime (`--update` into a temp dir), so it can never rot when the
 * schema evolves; the violation sample is a tampered copy of it.
 *
 * Usage: tsx scripts/verify-gate-fixtures.ts
 * Exit code 0 = every gate red on violation and green on clean, 1 = otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const GATES = join(root, "test/fixtures/gates");
const TSX = join(root, "node_modules/tsx/dist/cli.mjs");

export interface GateRun {
	readonly args: readonly string[];
	/** Working directory for the run (md-links fixtures run with cwd inside the fixture dir). */
	readonly cwd: string;
}

export interface GateCase {
	readonly id: string;
	readonly script: string;
	readonly violation: (fx: string) => GateRun;
	readonly clean: (fx: string) => GateRun;
	/** Static fixture files required under test/fixtures/gates/<id>/. */
	readonly fixtures: readonly string[];
	/** Runtime-generated samples (no static fixtures; handled by a dedicated checker). */
	readonly runtime?: true;
}

function at(fx: string, extra: readonly string[] = []): GateRun {
	return { args: [fx, ...extra], cwd: root };
}

export const GATE_CASES: readonly GateCase[] = [
	{
		id: "adr-format",
		script: "scripts/verify-adr-format.ts",
		violation: (fx) => at(join(fx, "notes")),
		clean: (fx) => at(join(fx, "notes")),
		fixtures: ["violation/notes/proposed/bad.md", "clean/notes/proposed/good.md"],
	},
	{
		id: "doc-budgets",
		script: "scripts/verify-doc-budgets.ts",
		violation: (fx) => ({ args: ["--manifest", join(fx, "manifest.json")], cwd: fx }),
		clean: (fx) => ({ args: ["--manifest", join(fx, "manifest.json")], cwd: fx }),
		fixtures: ["violation/manifest.json", "violation/doc.md", "clean/manifest.json", "clean/doc.md"],
	},
	{
		id: "md-links",
		script: "scripts/verify-md-links.ts",
		// cwd inside the fixture dir: the repo-wide run skips the
		// test/fixtures/gates tree, so the directed run must not walk it by name.
		violation: (fx) => ({ args: ["."], cwd: fx }),
		clean: (fx) => ({ args: ["."], cwd: fx }),
		fixtures: ["violation/a.md", "clean/b.md", "clean/other.md"],
	},
	{
		id: "governance",
		script: "scripts/verify-governance.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: [
			"violation/.github/ISSUE_TEMPLATE/bug.yml",
			"violation/.github/pull_request_template.md",
			"clean/.github/ISSUE_TEMPLATE/bug.yml",
			"clean/.github/pull_request_template.md",
		],
	},
	{
		id: "src-budgets",
		script: "scripts/verify-src-budgets.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: ["violation/evil.ts", "clean/small.ts"],
	},
	{
		id: "layering",
		script: "scripts/verify-layering.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: ["violation/evil.ts", "clean/data/database.ts"],
	},
	{
		id: "handoff-structure",
		script: "scripts/verify-handoff-structure.ts",
		violation: (fx) => at(fx, ["--handoff", join(fx, "HANDOFF.md")]),
		clean: (fx) => at(fx, ["--handoff", join(fx, "HANDOFF.md")]),
		fixtures: ["violation/HANDOFF.md", "clean/HANDOFF.md", "clean/HANDOFF-todos.md", "clean/HANDOFF.archive.md"],
	},
	{
		id: "schema-snapshot",
		script: "scripts/verify-schema-snapshot.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: [],
		runtime: true,
	},
	{
		id: "pack-contents",
		script: "scripts/verify-pack-contents.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: [
			"violation/src/a.ts",
			"violation/lib/a.js",
			"violation/lib/a.d.ts",
			"violation/lib/orphan.js",
			"violation/package.json",
			"clean/src/a.ts",
			"clean/lib/a.js",
			"clean/lib/a.d.ts",
			"clean/package.json",
		],
	},
	{
		id: "adr-coverage",
		script: "scripts/verify-adr-coverage.ts",
		violation: (fx) => ({ args: ["--changed-file", join(fx, "changed.txt")], cwd: root }),
		clean: (fx) => ({ args: ["--changed-file", join(fx, "changed.txt")], cwd: root }),
		fixtures: ["violation/changed.txt", "clean/changed.txt"],
	},
	{
		id: "dep-cycles",
		script: "scripts/verify-dep-cycles.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: ["violation/a.ts", "violation/b.ts", "clean/small.ts"],
	},
	{
		id: "budget-ratchet",
		script: "scripts/verify-budget-ratchet.ts",
		violation: (fx) => ({ args: [join(fx, "src"), "--baseline", join(fx, "baseline.json")], cwd: root }),
		clean: (fx) => ({ args: [join(fx, "src"), "--baseline", join(fx, "baseline.json")], cwd: root }),
		fixtures: ["violation/src/evil.ts", "violation/baseline.json", "clean/src/small.ts", "clean/baseline.json"],
	},
	{
		id: "layer-allowlist",
		script: "scripts/verify-layer-allowlist.ts",
		violation: (fx) => ({ args: [join(fx, "src"), "--layers", join(fx, "layers.json")], cwd: root }),
		clean: (fx) => ({ args: [join(fx, "src"), "--layers", join(fx, "layers.json")], cwd: root }),
		fixtures: ["violation/src/foo/evil.ts", "violation/layers.json", "clean/src/data/ok.ts", "clean/layers.json"],
	},
	{
		id: "test-pairing",
		script: "scripts/verify-test-pairing.ts",
		violation: (fx) => ({ args: ["--src", join(fx, "src"), "--tests", join(fx, "test"), "--exempt", join(fx, "test-exempt.json")], cwd: root }),
		clean: (fx) => ({ args: ["--src", join(fx, "src"), "--tests", join(fx, "test"), "--exempt", join(fx, "test-exempt.json")], cwd: root }),
		fixtures: [
			"violation/src/foo.ts",
			"violation/test/other.test.ts",
			"violation/test-exempt.json",
			"clean/src/bar.ts",
			"clean/test/bar.test.ts",
			"clean/test-exempt.json",
		],
	},
	{
		id: "api-snapshot",
		script: "scripts/verify-api-snapshot.ts",
		violation: (fx) => at(fx),
		clean: (fx) => at(fx),
		fixtures: [],
		runtime: true,
	},
];

/** A gate run's outcome. */
function runGate(script: string, run: GateRun): { status: number; output: string } {
	const r = spawnSync(process.execPath, [TSX, join(root, script), ...run.args], { cwd: run.cwd, encoding: "utf-8" });
	return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function main(): number {
	const errors: string[] = [];

	// Static gates: every listed fixture file must exist, violation must be
	// red, clean must be green — in that order. Runtime gates (schema-snapshot)
	// generate their samples on the fly and are checked below.
	for (const gate of GATE_CASES) {
		if (gate.runtime === true) continue;
		const dir = join(GATES, gate.id);
		for (const file of gate.fixtures) {
			if (!existsSync(join(dir, file))) {
				errors.push(`${gate.id}: fixture missing: test/fixtures/gates/${gate.id}/${file}`);
			}
		}
		if (errors.some((e) => e.startsWith(`${gate.id}: fixture missing`))) continue;

		const bad = runGate(gate.script, gate.violation(join(dir, "violation")));
		if (bad.status === 0) {
			errors.push(`${gate.id}: VIOLATION sample exits 0 (fake gate?) — output was:\n${bad.output}`);
		}
		const good = runGate(gate.script, gate.clean(join(dir, "clean")));
		if (good.status !== 0) {
			errors.push(`${gate.id}: CLEAN sample exits ${good.status} — output was:\n${good.output}`);
		}
		if (!errors.some((e) => e.startsWith(`${gate.id}:`))) {
			console.log(`OK   ${gate.id}: violation red + clean green`);
		}
	}

	// schema-snapshot: runtime-generated samples (never rots with the schema).
	const snapErrors = checkSchemaSnapshotGate();
	errors.push(...snapErrors);

	// api-snapshot: same runtime shape — the clean sample is a fresh --update,
	// the violation sample is a tampered copy, so exports can evolve freely.
	const apiErrors = checkApiSnapshotGate();
	errors.push(...apiErrors);

	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log(`OK（${GATE_CASES.length} gates red-green proven）`);
	return 0;
}

/**
 * schema-snapshot's red/green without static fixtures: generate a clean
 * snapshot into a temp dir (`--update`), prove it verifies green, tamper
 * one byte, prove it verifies red.
 */
function checkSchemaSnapshotGate(): string[] {
	const errors: string[] = [];
	const tmp = mkdtempSync(join(tmpdir(), "evolve-g3-"));
	try {
		const snap = join(tmp, "schema.sql");
		const updated = runGate("scripts/verify-schema-snapshot.ts", {
			args: ["--snapshot", snap, "--update"],
			cwd: root,
		});
		if (updated.status !== 0) {
			return [`schema-snapshot: --update failed:\n${updated.output}`];
		}
		const good = runGate("scripts/verify-schema-snapshot.ts", {
			args: ["--snapshot", snap],
			cwd: root,
		});
		if (good.status !== 0) {
			errors.push(`schema-snapshot: CLEAN (fresh --update) exits ${good.status}:\n${good.output}`);
		}
		writeFileSync(snap, `${readFileSync(snap, "utf-8")}-- tampered\n`);
		const bad = runGate("scripts/verify-schema-snapshot.ts", {
			args: ["--snapshot", snap],
			cwd: root,
		});
		if (bad.status === 0) {
			errors.push("schema-snapshot: VIOLATION (tampered snapshot) exits 0 (fake gate?)");
		}
		if (errors.length === 0) {
			console.log("OK   schema-snapshot: violation red + clean green");
		}
		return errors;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * api-snapshot's red/green without static fixtures: generate a clean
 * snapshot into a temp dir (`--update`), prove it verifies green, tamper
 * one module's surface text, prove it verifies red.
 */
function checkApiSnapshotGate(): string[] {
	const errors: string[] = [];
	const tmp = mkdtempSync(join(tmpdir(), "evolve-g5-"));
	try {
		const snap = join(tmp, "api.json");
		const updated = runGate("scripts/verify-api-snapshot.ts", {
			args: ["--snapshot", snap, "--update"],
			cwd: root,
		});
		if (updated.status !== 0) {
			return [`api-snapshot: --update failed:\n${updated.output}`];
		}
		const good = runGate("scripts/verify-api-snapshot.ts", {
			args: ["--snapshot", snap],
			cwd: root,
		});
		if (good.status !== 0) {
			errors.push(`api-snapshot: CLEAN (fresh --update) exits ${good.status}:\n${good.output}`);
		}
		const data = JSON.parse(readFileSync(snap, "utf-8")) as { modules: Record<string, string> };
		const first = Object.keys(data.modules).sort()[0];
		if (first === undefined) {
			return ["api-snapshot: emitted snapshot has no modules"];
		}
		data.modules[first] = `${data.modules[first] ?? ""}\n// tampered\n`;
		writeFileSync(snap, `${JSON.stringify(data, null, 2)}\n`);
		const bad = runGate("scripts/verify-api-snapshot.ts", {
			args: ["--snapshot", snap],
			cwd: root,
		});
		if (bad.status === 0) {
			errors.push("api-snapshot: VIOLATION (tampered snapshot) exits 0 (fake gate?)");
		}
		if (errors.length === 0) {
			console.log("OK   api-snapshot: violation red + clean green");
		}
		return errors;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Run only under direct execution (tests import the matrix without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
