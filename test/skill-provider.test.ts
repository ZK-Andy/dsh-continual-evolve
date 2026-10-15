import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUNDLED_SKILL_RANK,
	CREATOR_SKILLS,
	CREATOR_SKILLS_PROVIDER,
	createCreatorProvider,
	packageAssetsDir,
	registerCreatorSkills,
} from "../src/surfaces/skill-provider.js";

function seedDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "creator-skills-"));
	for (const [file, body] of Object.entries(files)) {
		writeFileSync(join(dir, file), body, "utf8");
	}
	return dir;
}

describe("creator skill provider", () => {
	it("lists both creators at the bundled rank with routable hooks", () => {
		const listed = createCreatorProvider("/nonexistent").list();
		expect(listed.map((entry) => entry.name).sort()).toEqual(
			CREATOR_SKILLS.map((spec) => spec.id).sort(),
		);
		for (const entry of listed) {
			expect(entry.provider).toBe(CREATOR_SKILLS_PROVIDER);
			expect(entry.source).toBe("bundled");
			expect(entry.rank).toBe(BUNDLED_SKILL_RANK);
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.description.length).toBeLessThanOrEqual(240);
			expect(entry.description).not.toMatch(/[\r\n]/);
		}
	});

	it("loads the file body verbatim", async () => {
		const dir = seedDir({ "evolve-skill-creator.md": "# dry run\n", "evolve-memory-creator.md": "# wet run\n" });
		const provider = createCreatorProvider(dir);
		const skill = await provider.get({ name: "evolve-skill-creator" });
		expect(skill.content).toBe("# dry run\n");
		expect(skill.name).toBe("evolve-skill-creator");
	});

	it("rereads the asset on every load instead of caching", async () => {
		const dir = seedDir({ "evolve-skill-creator.md": "v1\n", "evolve-memory-creator.md": "w1\n" });
		const provider = createCreatorProvider(dir);
		expect((await provider.get({ name: "evolve-skill-creator" })).content).toBe("v1\n");
		writeFileSync(join(dir, "evolve-skill-creator.md"), "v2\n", "utf8");
		expect((await provider.get({ name: "evolve-skill-creator" })).content).toBe("v2\n");
	});

	it("fails loud on unknown names and missing assets", async () => {
		const provider = createCreatorProvider(seedDir({}));
		await expect(provider.get({ name: "no-such-skill" })).rejects.toThrow("unknown creator skill");
		await expect(provider.get({ name: "evolve-skill-creator" })).rejects.toThrow();
	});

	it("registers one working provider with the host service", async () => {
		const dir = seedDir({ "evolve-skill-creator.md": "s\n", "evolve-memory-creator.md": "m\n" });
		const factories: Array<() => { list: () => unknown[] }> = [];
		registerCreatorSkills(
			{ registerProvider: (factory) => factories.push(factory as () => { list: () => unknown[] }) },
			dir,
		);
		expect(factories).toHaveLength(1);
		const provider = factories[0]?.();
		expect(provider?.list()).toHaveLength(CREATOR_SKILLS.length);
	});

	it("serves the packaged assets from the real package directory", async () => {
		const provider = createCreatorProvider(packageAssetsDir());
		for (const spec of CREATOR_SKILLS) {
			const loaded = await provider.get({ name: spec.id });
			expect(loaded.content).toContain(spec.id === "evolve-skill-creator" ? "Skill Creator" : "Memory Creator");
		}
	});
});
