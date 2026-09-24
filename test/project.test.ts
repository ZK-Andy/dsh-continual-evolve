/**
 * Tests for the project scope identity: stable slug-hash keys, best-effort
 * agent derivation, and traversal-safe store paths.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKeyOf, resolveProjectKey, sanitizeProjectKey } from "../src/project.js";
import { storePaths } from "../src/store.js";

describe("resolveProjectKey", () => {
	it("is stable for the same workspace path", () => {
		expect(resolveProjectKey("/mnt/work/app")).toBe(resolveProjectKey("/mnt/work/app"));
	});

	it("discriminates different workspaces", () => {
		expect(resolveProjectKey("/mnt/work/app-a")).not.toBe(resolveProjectKey("/mnt/work/app-b"));
	});

	it("derives the slug from the directory basename", () => {
		expect(resolveProjectKey("/mnt/work/my-app")).toMatch(/^my-app-[0-9a-f]{16}$/);
	});

	it("folds an explicit workspace identity to a shared key", () => {
		expect(resolveProjectKey("/mnt/work/a", "team-app")).toBe(resolveProjectKey("/mnt/work/b", "team-app"));
		expect(resolveProjectKey("/mnt/work/a", "team-app")).toMatch(/^project-[0-9a-f]{16}$/);
	});
});

describe("projectKeyOf", () => {
	it("derives the key from the session header cwd", () => {
		const agent = { id: "s", session: { header: { cwd: "/mnt/work/app" } } };
		expect(projectKeyOf(agent)).toBe(resolveProjectKey("/mnt/work/app"));
	});

	it("returns undefined when no cwd is present — never throws", () => {
		expect(projectKeyOf(undefined)).toBeUndefined();
		expect(projectKeyOf({ id: "s" })).toBeUndefined();
		expect(projectKeyOf({ id: "s", session: { header: {} } })).toBeUndefined();
		expect(projectKeyOf({ id: "s", session: { header: { cwd: "relative/path" } } })).toBeUndefined();
		expect(projectKeyOf({ id: "s", session: { header: { cwd: 42 } } })).toBeUndefined();
	});
});

describe("sanitizeProjectKey", () => {
	it("strips traversal segments to a single safe segment", () => {
		const evil = sanitizeProjectKey("../../evil");
		expect(evil).not.toContain("/");
		expect(evil.length).toBeGreaterThan(0);
		expect(sanitizeProjectKey("")).toBe("project");
		expect(sanitizeProjectKey(resolveProjectKey("/mnt/work/app"))).toBe(resolveProjectKey("/mnt/work/app"));
	});
});

describe("storePaths project scope", () => {
	it("lands under evolve/projects/<key>", () => {
		const dir = mkdtempSync(join(tmpdir(), "project-paths-"));
		try {
			const key = resolveProjectKey("/mnt/work/app");
			const paths = storePaths(dir, "project", key);
			expect(paths.stateDir).toBe(join(dir, "evolve", "projects", key));
			// traversal in, no traversal out
			const evil = storePaths(dir, "project", "../../evil").stateDir;
			expect(evil).toBe(join(dir, "evolve", "projects", sanitizeProjectKey("../../evil")));
			expect(evil.startsWith(join(dir, "evolve", "projects") + "/")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
