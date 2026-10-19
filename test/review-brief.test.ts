import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BRIEFS_DIR,
	checkRepo,
	freezeViolations,
	isSelfRoot,
	roundDeltaViolations,
	roundOf,
	tierLanes,
	violationsForLane,
} from "../scripts/verify-review-brief.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function goodBrief(lane: "R1" | "R2" | "R3", extra = ""): string {
	return `# ${lane} 评审简报（lane）\n\n## Scope\n- base: a  head: b\n- 需深审面：src/A.ts\n- 陪跑文件：无\n- diff 面相邻件：无\n${extra}\n## Directed checks\n- [ ] 核对 A 契约，证据在 src/A.ts:1\n\n## Explicitly out of scope\n- 不追 diff 面之外的调用方全图\n\n## Report contract\n- 返回 \`Blocker[]/Suggestion[]\`，每条 \`文件:行 + 一句证据\`；空即"无发现"\n`;
}

function writeBrief(dir: string, name: string, text: string): string {
	mkdirSync(join(dir, BRIEFS_DIR), { recursive: true });
	const full = join(dir, BRIEFS_DIR, name);
	writeFileSync(full, text);
	return full;
}

describe("roundOf", () => {
	it("reads -r<K> suffix, else round 1", () => {
		expect(roundOf("R2-a.md")).toBe(1);
		expect(roundOf("R2-a-r2.md")).toBe(2);
		expect(roundOf("R1-a-r4.md")).toBe(4);
	});
});

describe("violationsForLane shape", () => {
	it("accepts a well-formed brief", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(dir, "R2-a.md", goodBrief("R2"));
		expect(violationsForLane(file, "R2")).toEqual([]);
	});

	it("flags missing out-of-scope (unbounded task)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(dir, "R2-a.md", goodBrief("R2").replace("## Explicitly out of scope\n- 不追 diff 面之外的调用方全图\n\n", ""));
		expect(violationsForLane(file, "R2").some((s) => s.includes("out of scope"))).toBe(true);
	});

	it("flags >5 directed checks", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const checks = Array.from({ length: 6 }, (_, i) => `- [ ] c${i}\n`).join("");
		const text = goodBrief("R2").replace("- [ ] 核对 A 契约，证据在 src/A.ts:1\n", checks);
		const file = writeBrief(dir, "R2-a.md", text);
		expect(violationsForLane(file, "R2").some((s) => s.includes(">5"))).toBe(true);
	});

	it("rejects 需深审面：无", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(dir, "R2-a.md", goodBrief("R2").replace("- 需深审面：src/A.ts", "- 需深审面：无"));
		expect(violationsForLane(file, "R2").some((s) => s.includes("需深审面 must name"))).toBe(true);
	});

	it("requires 门禁自证 when companions claim gated", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const text = goodBrief("R2").replace("- 陪跑文件：无", "- 陪跑文件：src/B.ts（机器门禁已盖）");
		const file = writeBrief(dir, "R2-a.md", text);
		expect(violationsForLane(file, "R2").some((s) => s.includes("门禁自证"))).toBe(true);
	});

	it("rejects non-zero self-assertion exits", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const text = `${"# R2 评审简报（lane）\n\n## Scope\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：src/A.ts（机器门禁已盖）\n- 门禁自证：dotnet-format:2，dotnet-test:0\n- diff 面相邻件：无\n\n"}## Directed checks\n- [ ] c\n\n## Explicitly out of scope\n- d\n\n## Report contract\n- 返回 \`Blocker[]/Suggestion[]\`；空即无发现\n`;
		const file = writeBrief(dir, "R2-a.md", text);
		expect(violationsForLane(file, "R2").some((s) => s.includes("非 0 exit"))).toBe(true);
	});

	it("rejects multi-digit and ≥3 exits (no numeric escape)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const mk = (assertion: string): string =>
			`# R2 评审简报（lane）\n\n## Scope\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：src/A.ts（机器门禁已盖）\n- 门禁自证：${assertion}\n- diff 面相邻件：无\n\n## Directed checks\n- [ ] c\n\n## Explicitly out of scope\n- d\n\n## Report contract\n- 返回 \`Blocker[]/Suggestion[]\`；空即无发现\n`;
		const f10 = writeBrief(dir, "R2-a.md", mk("dotnet-format:10，dotnet-test:0"));
		expect(violationsForLane(f10, "R2").some((s) => s.includes("非 0 exit"))).toBe(true);
		const dir2 = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const f3 = writeBrief(dir2, "R2-a.md", mk("dotnet-format:3"));
		expect(violationsForLane(f3, "R2").some((s) => s.includes("非 0 exit"))).toBe(true);
	});

	it("rejects a self-assertion line with no parseable items", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(
			dir,
			"R2-a.md",
			"# R2 评审简报（lane）\n\n## Scope\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：src/A.ts（机器门禁已盖）\n- 门禁自证：已人工确认\n- diff 面相邻件：无\n\n## Directed checks\n- [ ] c\n\n## Explicitly out of scope\n- d\n\n## Report contract\n- 返回 `Blocker[]/Suggestion[]`；空即无发现\n",
		);
		expect(violationsForLane(file, "R2").some((s) => s.includes("无可解析"))).toBe(true);
	});

	it("ignores base:/key mentions outside the Scope zone", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(
			dir,
			"R2-a.md",
			"# R2 评审简报（lane）\n\n## Scope\n- 需深审面：src/A.ts\n- 陪跑文件：无\n- diff 面相邻件：无\n\n## Directed checks\n- [ ] 核对 rebase: abc 流程，证据在 src/A.ts:1\n\n## Explicitly out of scope\n- d\n\n## Report contract\n- 返回 `Blocker[]/Suggestion[]`；空即无发现\n",
		);
		// `rebase: abc` contains `base: abc` — it must not satisfy the Scope shape.
		expect(violationsForLane(file, "R2").some((s) => s.includes("base: <ref>"))).toBe(true);
	});

	it("flags title/filename round mismatch and round-1 dispositions", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const file = writeBrief(dir, "R2-a.md", "# R2 评审简报（lane）· 第 2 轮\n" + goodBrief("R2").split("\n").slice(1).join("\n"));
		expect(violationsForLane(file, "R2").some((s) => s.includes("与文件名"))).toBe(true);
		const file2 = writeBrief(dir, "R2-b.md", `${goodBrief("R2")}## 上一轮结论的处置\n- B1 已改\n`);
		expect(violationsForLane(file2, "R2").some((s) => s.includes("却是第 1 轮"))).toBe(true);
	});

	it("requires dispositions on verification rounds, caps at 3 without auth", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		const head = "# R2 评审简报（lane）· 第 2 轮\n\n## Scope\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：无\n- diff 面相邻件：无\n\n";
		const tail = "## Directed checks\n- [ ] c\n\n## Explicitly out of scope\n- d\n\n## Report contract\n- 返回 `Blocker[]/Suggestion[]`；空即无发现\n";
		const noDisp = writeBrief(dir, "R2-a-r2.md", head + tail);
		expect(violationsForLane(noDisp, "R2").some((s) => s.includes("上一轮结论的处置"))).toBe(true);
		const r4 = writeBrief(dir, "R1-a-r4.md", `# R1 评审简报（lane）· 第 4 轮\n\n## Scope\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：无\n- diff 面相邻件：无\n\n## 上一轮结论的处置\n- B1 已改\n\n${tail}`);
		expect(violationsForLane(r4, "R1").some((s) => s.includes("超出上限"))).toBe(true);
		const r4auth = writeBrief(dir, "R1-b-r4.md", `# R1 评审简报（lane）· 第 4 轮\n\n## Scope\n- 轮次授权：用户显式批准再开一轮\n- base: a  head: b\n- 需深审面：x\n- 陪跑文件：无\n- diff 面相邻件：无\n\n## 上一轮结论的处置\n- B1 已改\n\n${tail}`);
		expect(violationsForLane(r4auth, "R1").filter((s) => s.includes("超出上限"))).toEqual([]);
	});
});

describe("checkRepo + freeze (git)", () => {
	it("missing brief is a violation; G3 clean fixture passes", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-brief-"));
		expect(checkRepo(dir, ["R2"]).some((s) => s.includes("missing brief"))).toBe(true);
		const clean = join(root, "test/fixtures/gates/review-brief/clean");
		expect(checkRepo(clean, ["R2"])).toEqual([]);
	});

	it("frozen staged set passes; drift and untracked fail", () => {
		const repo = mkdtempSync(join(tmpdir(), "evolve-freeze-"));
		const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		git("init", "-qb", "main");
		git("config", "user.email", "b@test.invalid");
		git("config", "user.name", "b");
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, ".gitignore"), `${BRIEFS_DIR}/\n`);
		git("add", ".");
		git("commit", "-qm", "base");
		expect(freezeViolations(repo)).toEqual([]);
		writeFileSync(join(repo, "a.txt"), "two\n");
		expect(freezeViolations(repo).some((s) => s.includes("re-stage or discard"))).toBe(true);
		git("add", "a.txt");
		expect(freezeViolations(repo)).toEqual([]);
		writeFileSync(join(repo, "stray.txt"), "?\n");
		expect(freezeViolations(repo).some((s) => s.includes("untracked file") && s.includes("stray.txt"))).toBe(true);
	});

	it("fixture dirs inside the repo never read the parent worktree", () => {
		const fixture = join(root, "test/fixtures/gates/review-brief/clean");
		expect(isSelfRoot(fixture)).toBe(false);
		expect(isSelfRoot(root)).toBe(true);
		// Shape checks still run; freeze/delta stay silent even when the
		// parent worktree is dirty (G3 runs with uncommitted changes around).
		expect(checkRepo(fixture, ["R2"])).toEqual([]);
		expect(freezeViolations(fixture)).toEqual([]);
		expect(roundDeltaViolations(fixture, ["R2"])).toEqual([]);
		expect(tierLanes(fixture)).toEqual(["R1", "R2", "R3"]);
	});
});
