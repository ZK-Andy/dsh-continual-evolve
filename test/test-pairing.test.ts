import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPairing, listTsFiles, readExempt } from "../scripts/verify-test-pairing.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("checkPairing", () => {
	it("passes paired modules", () => {
		const result = checkPairing(["src/a.ts"], new Set(["test/a.test.ts"]), new Set());
		expect(result.ok).toBe(true);
	});

	it("pairs across directories by basename", () => {
		const result = checkPairing(["src/pages/mount.ts"], new Set(["test/mount.test.ts"]), new Set());
		expect(result.ok).toBe(true);
	});

	it("fails unpaired modules without an exemption", () => {
		const result = checkPairing(["src/foo.ts"], new Set(["test/other.test.ts"]), new Set());
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual(["src/foo.ts"]);
	});

	it("honours exemptions", () => {
		const result = checkPairing(["src/foo.ts"], new Set(["test/other.test.ts"]), new Set(["src/foo.ts"]));
		expect(result.ok).toBe(true);
	});

	it("flags stale exemptions when the module is gone", () => {
		const result = checkPairing(["src/a.ts"], new Set(["test/a.test.ts"]), new Set(["src/gone.ts"]));
		expect(result.ok).toBe(false);
		expect(result.stale).toEqual(["src/gone.ts"]);
	});

	it("flags stale exemptions when the test now exists", () => {
		const result = checkPairing(["src/a.ts"], new Set(["test/a.test.ts"]), new Set(["src/a.ts"]));
		expect(result.ok).toBe(false);
		expect(result.stale).toEqual(["src/a.ts"]);
	});
});

describe("test-pairing fixtures", () => {
	function fixtureCase(kind: "violation" | "clean") {
		const dir = join(root, "test/fixtures/gates/test-pairing", kind);
		const srcFiles = listTsFiles(join(dir, "src")).map((file) => `src/${relative(join(dir, "src"), file).replace(/\\/g, "/")}`);
		const testFiles = new Set(
			listTsFiles(join(dir, "test")).map((file) => relative(".", file).replace(/\\/g, "/")).filter((rel) => rel.endsWith(".test.ts")),
		);
		return checkPairing(srcFiles, testFiles, readExempt(join(dir, "test-exempt.json")));
	}

	it("is red on the unpaired foo module", () => {
		const result = fixtureCase("violation");
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual(["src/foo.ts"]);
	});

	it("is green on the paired bar module", () => {
		expect(fixtureCase("clean").ok).toBe(true);
	});
});

describe("real tree", () => {
	it("holds the pairing with the committed exempt list", () => {
		const srcFiles = listTsFiles(join(root, "src")).map((file) => `src/${relative(join(root, "src"), file).replace(/\\/g, "/")}`);
		const testFiles = new Set(
			listTsFiles(join(root, "test")).map((file) => relative(root, file).replace(/\\/g, "/")).filter((rel) => rel.endsWith(".test.ts")),
		);
		const result = checkPairing(srcFiles, testFiles, readExempt(join(root, "scripts/test-exempt.json")));
		expect(result.missing).toEqual([]);
		expect(result.stale).toEqual([]);
		expect(result.ok).toBe(true);
	});
});
