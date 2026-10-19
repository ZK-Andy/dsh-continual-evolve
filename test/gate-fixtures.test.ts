import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_CASES } from "../scripts/verify-gate-fixtures.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * G3's own guard: the red-green matrix must cover every gate and every
 * listed fixture file must exist. The live red/green proof runs in
 * `pnpm check:gate-fixtures` (registered in run-gates docs mode); this
 * test keeps the matrix from silently rotting (a gate added without
 * fixtures fails here, not in CI).
 */
describe("gate-fixtures matrix", () => {
	it("covers every verify-*.ts gate except itself", () => {
		const scripts = readdirSync(join(root, "scripts"))
			.filter((name) => name.startsWith("verify-") && name.endsWith(".ts"))
			.filter((name) => name !== "verify-gate-fixtures.ts")
			.sort();
		const covered = GATE_CASES.map((gate) => gate.script.split("/").at(-1)).sort();
		expect(covered).toEqual(scripts);
	});

	it("lists no duplicate gate ids", () => {
		const ids = GATE_CASES.map((gate) => gate.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every listed fixture file exists", () => {
		const missing: string[] = [];
		for (const gate of GATE_CASES) {
			for (const file of gate.fixtures) {
				const full = join(root, "test/fixtures/gates", gate.id, file);
				if (!existsSync(full)) missing.push(`${gate.id}/${file}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("violation and clean samples are distinct trees", () => {
		for (const gate of GATE_CASES) {
			if (gate.runtime === true) continue;
			const kinds = new Set(gate.fixtures.map((file) => file.split("/")[0]));
			expect(kinds.has("violation")).toBe(true);
			expect(kinds.has("clean")).toBe(true);
		}
	});

	it("runtime gates are the documented exception only", () => {
		const runtime = GATE_CASES.filter((gate) => gate.runtime === true).map((gate) => gate.id);
		expect(runtime).toEqual(["schema-snapshot"]);
	});
});
