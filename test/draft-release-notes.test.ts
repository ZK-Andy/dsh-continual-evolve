import { describe, expect, it } from "vitest";
import { bulletOf, compareBaseOf, groupCommits, parseLog, renderNotes } from "../scripts/draft-release-notes.js";

describe("groupCommits", () => {
	it("groups feat/fix/other and skips the release bump", () => {
		const groups = groupCommits([
			{ hash: "abcdef123456", author: "ann", subject: "feat(store): add thing" },
			{ hash: "123456abcdef", author: "bob", subject: "fix(card): mend fence" },
			{ hash: "deadbee00000", author: "ann", subject: "refactor!: drop shim" },
			{ hash: "c0ffee000000", author: "ann", subject: "chore(release): v0.1.0" },
			{ hash: "", author: "", subject: "" },
		]);
		expect(groups.feat).toEqual(["- feat(store): add thing (@ann) <!-- abcdef1 -->"]);
		expect(groups.fix).toEqual(["- fix(card): mend fence (@bob) <!-- 123456a -->"]);
		expect(groups.other).toEqual(["- refactor!: drop shim (@ann) <!-- deadbee -->"]);
	});
});

describe("parseLog", () => {
	it("splits head-first so subjects may contain pipes", () => {
		expect(parseLog("abc|ann|a|b|c\nbroken\n")).toEqual([{ hash: "abc", author: "ann", subject: "a|b|c" }]);
	});
});

describe("compareBaseOf", () => {
	it("normalizes https and scp-like origins", () => {
		expect(compareBaseOf("https://github.com/o/r.git")).toBe("https://github.com/o/r");
		expect(compareBaseOf("git@github.com:o/r.git")).toBe("https://github.com/o/r");
	});
});

describe("renderNotes", () => {
	it("renders the bilingual shape with empties and changelog links", () => {
		const notes = renderNotes("v0.2.0", "0.2.0", "pkg", "v0.1.0", "https://github.com/o/r", "v0.1.0", {
			feat: ["- feat: x (@ann) <!-- abc -->"],
			fix: [],
			other: [],
		});
		expect(notes).toContain("[中文](#cn-v0.2.0) | [English](#en-v0.2.0)");
		expect(notes).toContain("- feat: x (@ann) <!-- abc -->");
		expect(notes).toContain("- （无）");
		expect(notes).toContain("- (none)");
		expect(notes).toContain("Full Changelog: [v0.1.0...v0.2.0](https://github.com/o/r/compare/v0.1.0...v0.2.0)");
		expect(notes).toContain("npm: https://www.npmjs.com/package/pkg/v/0.2.0");
		expect(bulletOf({ hash: "abcdef123456", author: "ann", subject: "feat: x" })).toBe("- feat: x (@ann) <!-- abcdef1 -->");
	});
});
