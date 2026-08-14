/**
 * Hot-mount tests: generated plugin packages, argument-contract mapping,
 * ledger persistence, and mount/unmount without a loader service.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEntry } from "../src/types.js";
import {
	loadLedger,
	mountSkill,
	renderMountPackage,
	renderParameters,
	renderPluginSource,
	unmountSkill,
} from "../src/mount.js";

function skillEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "code_reviewer",
		kind: "skill",
		title: "Code reviewer",
		content: "Review the diff strictly.",
		path: "general",
		scope: "local",
		reference: { type: "python", import: "reviewer", callable: "run" },
		arguments: { strictness: { type: "string", required: true, description: "how strict" } },
		metadata: {},
		source: "evolve",
		created_at: "2026-08-14T00:00:00.000Z",
		updated_at: "2026-08-14T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function makeBase(): string {
	return mkdtempSync(join(tmpdir(), "evolve-mount-"));
}

describe("renderMountPackage", () => {
	it("writes package.json and index.js for a skill entry", () => {
		const base = makeBase();
		try {
			const dir = renderMountPackage(base, skillEntry());
			expect(existsSync(join(dir, "package.json"))).toBe(true);
			expect(existsSync(join(dir, "index.js"))).toBe(true);
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
			expect(pkg["name"]).toBe("evolve-skill-code-reviewer");
			expect(pkg["type"]).toBe("module");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("generates a plugin that registers a tool with the entry's contract", () => {
		const source = renderPluginSource("skill_code_reviewer", skillEntry());
		expect(source).toContain('export const name = "evolve-skill-code-reviewer"');
		expect(source).toContain('export const inject = ["tools"];');
		expect(source).toContain('name: "skill_code_reviewer"');
		expect(source).toContain("Review the diff strictly.");
		expect(source).toContain('"strictness"');
		// requiredness is a root-level array (JSON.stringify pretty-print form);
		// the raw register path sends `parameters` verbatim to the API, which
		// rejects per-property `required: true` ("true is not of type array").
		expect(source).toContain('"required": [\n    "strictness"\n  ]');
		expect(source).not.toContain('"required": true');
		expect(source).toContain("Python reference:");
		expect(source).toContain("reviewer");
		// output value-schema must not carry `required` on the string property
		// (direct register rejects it — FAQ #2 compileValueSchema path).
		expect(source).not.toContain('text: { type: "string", required: true }');
	});
});

describe("renderParameters", () => {
	it("maps required contract entries to a root-level required array", () => {
		const parameters = renderParameters(
			skillEntry({
				arguments: {
					path: { type: "string", required: true, description: "target path" },
					depth: { type: "number", description: "optional depth" },
				},
			}),
		);
		const props = (parameters["properties"] as Record<string, Record<string, unknown>>) ?? {};
		expect(parameters["required"]).toEqual(["path"]);
		expect(props["path"]?.["required"]).toBeUndefined();
		expect(props["depth"]?.["required"]).toBeUndefined();
	});

	it("tolerates a missing arguments contract", () => {
		const parameters = renderParameters(skillEntry({ arguments: {} }));
		expect(parameters["properties"]).toEqual({});
		expect(parameters["required"]).toBeUndefined();
	});
});

describe("mountSkill / unmountSkill", () => {
	it("writes the package and ledger without a loader service", async () => {
		const base = makeBase();
		try {
			const ctx = {} as never; // no loader -> package + ledger only
			const record = await mountSkill(ctx, base, skillEntry());
			expect(record.id).toBe("code_reviewer");
			expect(record.entryId).toBe("evolve-mount-code-reviewer");
			expect(loadLedger(base).mounted).toHaveLength(1);
			expect(existsSync(join(record.path, "index.js"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("remounting the same id replaces the ledger record", async () => {
		const base = makeBase();
		try {
			const ctx = {} as never;
			await mountSkill(ctx, base, skillEntry({ version: 1 }));
			await mountSkill(ctx, base, skillEntry({ version: 2 }));
			const ledger = loadLedger(base);
			expect(ledger.mounted).toHaveLength(1);
			expect(ledger.mounted[0]?.version).toBe(2);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("unmount removes the ledger record and the package", async () => {
		const base = makeBase();
		try {
			const ctx = {} as never;
			await mountSkill(ctx, base, skillEntry());
			const record = await unmountSkill(ctx, base, "code_reviewer");
			expect(record?.id).toBe("code_reviewer");
			expect(loadLedger(base).mounted).toHaveLength(0);
			expect(existsSync(join(base, "evolve", "mounted", "code-reviewer"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("unmount of an unknown id is a no-op returning undefined", async () => {
		const base = makeBase();
		try {
			const record = await unmountSkill({} as never, base, "nope");
			expect(record).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
