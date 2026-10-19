import { describe, expect, it } from "vitest";
import { checkAdrCoverage, normalizeChanged } from "../scripts/verify-adr-coverage.js";

describe("normalizeChanged", () => {
	it("dedupes, sorts, and strips dot-slash prefixes", () => {
		expect(normalizeChanged(["src/b.ts", "./src/a.ts", "src/b.ts", ""])).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("checkAdrCoverage", () => {
	it("passes when nothing changed", () => {
		expect(checkAdrCoverage([]).ok).toBe(true);
	});

	it("passes for docs-only diffs without an ADR", () => {
		expect(checkAdrCoverage(["docs/guide.md", "test/foo.test.ts", "scripts/x.ts"]).ok).toBe(true);
	});

	it("fails for src changes without an ADR", () => {
		const result = checkAdrCoverage(["src/services/foo.ts", "docs/guide.md"]);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("src/services/foo.ts");
	});

	it("passes for src changes carrying a proposed note", () => {
		const result = checkAdrCoverage(["src/services/foo.ts", ".agents/notes/proposed/architecture/2026-10-20-foo.md"]);
		expect(result.ok).toBe(true);
	});

	it("passes for src changes carrying an implemented note", () => {
		const result = checkAdrCoverage(["src/x.ts", ".agents/notes/implemented/bug-fix/2026-10-19-fix.md"]);
		expect(result.ok).toBe(true);
	});

	it("does not count archived notes as coverage", () => {
		const result = checkAdrCoverage(["src/x.ts", ".agents/notes/archived/old.md"]);
		expect(result.ok).toBe(false);
	});

	it("does not count rejected notes as coverage", () => {
		const result = checkAdrCoverage(["src/x.ts", ".agents/notes/rejected/2026-10-19-no.md"]);
		expect(result.ok).toBe(false);
	});

	it("passes with an explicit no-adr exemption", () => {
		expect(checkAdrCoverage(["src/x.ts"], true).ok).toBe(true);
	});
});
