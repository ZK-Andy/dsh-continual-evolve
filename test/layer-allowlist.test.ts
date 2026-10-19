import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLayers, readAllowlist } from "../scripts/verify-layer-allowlist.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("checkLayers", () => {
	it("passes when every dir is allowlisted", () => {
		const result = checkLayers(["data", "services"], ["data", "pages", "services", "surfaces"]);
		expect(result.ok).toBe(true);
		expect(result.unknown).toEqual([]);
	});

	it("reports unknown dirs", () => {
		const result = checkLayers(["data", "foo"], ["data"]);
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(["foo"]);
	});

	it("passes on an empty tree", () => {
		expect(checkLayers([], ["data"]).ok).toBe(true);
	});
});

describe("readAllowlist", () => {
	it("rejects a missing file with a readable error", () => {
		expect(() => readAllowlist(join(root, "no-such-layers.json"))).toThrow(/缺失/);
	});
});

describe("layer-allowlist fixtures", () => {
	it("is red on the unallowlisted foo dir", () => {
		const allowed = readAllowlist(join(root, "test/fixtures/gates/layer-allowlist/violation/layers.json"));
		const result = checkLayers(["foo"], allowed);
		expect(result.ok).toBe(false);
	});

	it("is green on the allowlisted data dir", () => {
		const allowed = readAllowlist(join(root, "test/fixtures/gates/layer-allowlist/clean/layers.json"));
		expect(checkLayers(["data"], allowed).ok).toBe(true);
	});
});

describe("real tree", () => {
	it("holds only the four architecture layers", () => {
		const allowed = readAllowlist(join(root, "scripts/layers.json"));
		expect(allowed).toEqual(["data", "pages", "services", "surfaces"]);
	});
});
