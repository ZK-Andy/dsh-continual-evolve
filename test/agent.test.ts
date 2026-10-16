import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cwdOf } from "../src/services/agent.js";

let workspace = "";

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-agent-"));
});

describe("cwdOf", () => {
	it("returns undefined for a missing, cwd-less, or blank agent", () => {
		expect(cwdOf(undefined)).toBeUndefined();
		expect(cwdOf({})).toBeUndefined();
		expect(cwdOf({ session: { header: {} } })).toBeUndefined();
		expect(cwdOf({ session: { header: { cwd: "   " } } })).toBeUndefined();
	});

	it("returns undefined for a relative cwd and resolves an absolute one", () => {
		expect(cwdOf({ session: { header: { cwd: "relative/path" } } })).toBeUndefined();
		expect(cwdOf({ session: { header: { cwd: workspace } } })).toBe(workspace);
	});

	it("falls back to header.meta.cwd", () => {
		const agent = { session: { header: { meta: { cwd: workspace } } } };
		expect(cwdOf(agent)).toBe(workspace);
	});

	it("survives a throwing agent shape", () => {
		const hostile = {};
		Object.defineProperty(hostile, "session", {
			get() {
				throw new Error("boom");
			},
		});
		expect(cwdOf(hostile)).toBeUndefined();
	});
});
