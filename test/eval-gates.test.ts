import { describe, expect, it } from "vitest";
import { checkFreshness, parseCompareHeader } from "../scripts/verify-eval-freshness.js";
import { ANCHOR_FAIL_DAYS, ANCHOR_WARN_DAYS, checkAnchorDays } from "../scripts/check-eval-anchor.js";

/** Release-time freshness gate (P5a): release-window granularity, compare.md carries the commit. */
describe("checkFreshness", () => {
	const head = "abcdef1234567890";
	const compares = [{ file: "evals/runs/2026-10-19/compare.md", commit: "abcdef1234567890" }];

	it("passes doc-only changes without any compare (exemption)", () => {
		expect(
			checkFreshness({ tag: "v0.19.0", head, changedFiles: ["docs/guide.md", "package.json"], compares: [] }),
		).toEqual({ ok: true, reason: expect.stringContaining("exempt") });
	});

	it("fails touching changes with no covering compare", () => {
		const check = checkFreshness({ tag: "v0.19.0", head, changedFiles: ["src/services/memory-apply.ts"], compares: [] });
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("stale");
	});

	it("fails when the compare records an older commit (anti-fake acceptance)", () => {
		const check = checkFreshness({
			tag: "v0.19.0",
			head,
			changedFiles: ["src/data/records.ts"],
			compares: [{ file: "x/compare.md", commit: "0000000111111" }],
		});
		expect(check.ok).toBe(false);
	});

	it("passes when a compare covers head", () => {
		expect(checkFreshness({ tag: "v0.19.0", head, changedFiles: ["src/data/records.ts"], compares }).ok).toBe(true);
	});

	it("parses the commit from the compare header", () => {
		expect(parseCompareHeader("c.md", "commit: abcdef1\ndate: 2026-10-19\n"))?.toEqual({ file: "c.md", commit: "abcdef1" });
		expect(parseCompareHeader("c.md", "no header here\n")).toBeUndefined();
	});

	it("parses the markdown-list commit the runner actually writes (首跑回填形状)", () => {
		const rendered = "# 四臂对照 eval-2026-10-19\n\n- date: 2026-10-19\n- commit: 88c346f9d4a9765ea90ebcace488323d5df047ad\n- tasks: 22\n";
		expect(parseCompareHeader("compare.md", rendered))?.toEqual({
			file: "compare.md",
			commit: "88c346f9d4a9765ea90ebcace488323d5df047ad",
		});
	});
});

/** Anchor staleness (P5a): 60d warn, 67d fail, never-anchored warns. */
describe("checkAnchorDays", () => {
	it("keeps the 60/67-day thresholds observable", () => {
		expect(ANCHOR_WARN_DAYS).toBe(60);
		expect(ANCHOR_FAIL_DAYS).toBe(67);
	});

	it("passes fresh anchors and warns past the window", () => {
		expect(checkAnchorDays(30)).toMatchObject({ ok: true, level: "ok" });
		expect(checkAnchorDays(61)).toMatchObject({ ok: true, level: "warn" });
	});

	it("fails past the grace period and warns when never anchored", () => {
		expect(checkAnchorDays(68)).toMatchObject({ ok: false, level: "fail" });
		expect(checkAnchorDays(undefined)).toMatchObject({ ok: true, level: "warn" });
	});
});
