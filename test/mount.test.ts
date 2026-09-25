/**
 * Hot-mount tests: generated plugin packages, argument-contract mapping,
 * ledger persistence, and mount/unmount without a loader service.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEntry } from "../src/types.js";
import {
	loadLedger,
	mountSkill,
	renderMountPackage,
	renderParameters,
	renderPluginSource,
	restoreMounted,
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
	it("blocks entries carrying credentials before writing any file", () => {
		const base = makeBase();
		try {
			expect(() =>
				renderMountPackage(base, skillEntry({ content: `Call the API with token ghp_${"abcdefghijklmnopqrstuvwxyz123456"}` })),
			).toThrow(/mount blocked.*possible GitHub token/s);
			expect(existsSync(join(base, "evolve", "mounted"))).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

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
	it("falls back to an empty ledger for corrupt ledger JSON", () => {
		const base = makeBase();
		try {
			mkdirSync(join(base, "evolve", "mounted"), { recursive: true });
			writeFileSync(join(base, "evolve", "mounted", "index.json"), "{not json", "utf8");
			expect(loadLedger(base)).toEqual({ mounted: [] });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

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
	it("refuses to mount a guidance skill (no python reference)", async () => {
		const base = makeBase();
		try {
			const ctx = { get: () => undefined } as never;
			const guidance = skillEntry({ skill_kind: "guidance", reference: {}, arguments: {} });
			await expect(mountSkill(ctx, base, guidance)).rejects.toThrow(/guidance skills cannot be mounted/);
			expect(loadLedger(base).mounted).toHaveLength(0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("writes the package and ledger without a loader service", async () => {
		const base = makeBase();
		try {
			const ctx = { get: () => undefined } as never; // no loader -> package + ledger only
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
			const ctx = { get: () => undefined } as never;
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
			const ctx = { get: () => undefined } as never;
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
			const record = await unmountSkill({ get: () => undefined } as never, base, "nope");
			expect(record).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("mounts through the loader when the service is available", async () => {
		const base = makeBase();
		try {
			const created: { id: string; name: string }[] = [];
			const ctx = { get: () => ({ create: async (opts: { id: string; name: string }) => { created.push(opts); return opts.id; } }) } as never;
			const record = await mountSkill(ctx, base, skillEntry());
			expect(created).toHaveLength(1);
			expect(created[0]?.id).toBe(record.entryId);
			expect(created[0]?.name.endsWith("index.js")).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("wraps a loader creation failure as a hot mount error", async () => {
		const base = makeBase();
		try {
			const ctx = { get: () => ({ create: async () => { throw new Error("loader busy"); } }) } as never;
			await expect(mountSkill(ctx, base, skillEntry())).rejects.toThrow(/hot mount failed: loader busy/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("unmounts through the loader and wraps removal failures", async () => {
		const base = makeBase();
		try {
			const removed: string[] = [];
			const noLoader = { get: () => undefined } as never;
			await mountSkill(noLoader, base, skillEntry());
			const withLoader = { get: () => ({ remove: async (id: string) => { removed.push(id); } }) } as never;
			const record = await unmountSkill(withLoader, base, "code_reviewer");
			expect(record?.id).toBe("code_reviewer");
			expect(removed).toEqual([record?.entryId]);

			await mountSkill(noLoader, base, skillEntry());
			const failing = { get: () => ({ remove: async () => { throw new Error("gone"); } }) } as never;
			await expect(unmountSkill(failing, base, "code_reviewer")).rejects.toThrow(/hot unmount failed: gone/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("restoreMounted", () => {
	it("re-creates every ledger package through the loader at boot", async () => {
		const base = makeBase();
		try {
			const noLoader = { get: () => undefined } as never;
			const record = await mountSkill(noLoader, base, skillEntry());
			const created: { id: string; name: string }[] = [];
			const ctx = {
				get: () => ({ create: async (opts: { id: string; name: string }) => { created.push(opts); return opts.id; } }),
				logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
			} as never;
			await restoreMounted(ctx, base);
			expect(created).toHaveLength(1);
			expect(created[0]).toEqual({ id: record.entryId, name: join(record.path, "index.js") });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("skips ledger entries whose package was removed and runs loaderless without crashing", async () => {
		const base = makeBase();
		try {
			const noLoader = { get: () => undefined, logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) } as never;
			const record = await mountSkill(noLoader, base, skillEntry());
			// Package present but no loader: nothing to re-create, no crash.
			await restoreMounted(noLoader, base);
			rmSync(record.path, { recursive: true, force: true });
			await restoreMounted(noLoader, base);
			expect(loadLedger(base).mounted).toHaveLength(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("warns and continues when one restore fails", async () => {
		const base = makeBase();
		try {
			const noLoader = { get: () => undefined } as never;
			await mountSkill(noLoader, base, skillEntry());
			const warnings: string[] = [];
			const ctx = {
				get: () => ({ create: async () => { throw new Error("boot race"); } }),
				logger: () => ({ info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} }),
			} as never;
			await restoreMounted(ctx, base);
			expect(warnings.some((w) => w.includes("mount restore failed for code_reviewer"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
