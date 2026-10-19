import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NOTES_DIR,
	REVIEW_LINE_RE,
	classifyTier,
	headerZone,
	isValidDate,
	normalizeChanged,
	scanTier,
} from "../scripts/verify-review-tier.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function initRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "evolve-tier-"));
	git(repo, "init", "-qb", "main");
	git(repo, "config", "user.email", "tier@test.invalid");
	git(repo, "config", "user.name", "tier");
	return repo;
}

function write(repo: string, rel: string, text: string): void {
	const full = join(repo, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, text);
	git(repo, "add", rel);
}

const EVIDENCE = "# Agent Note: x\n\nStatus: implemented\n\nReview: FULL/2026-10-19/R1=ok R2=ok R3=ok\n\n## Problem\n\nx\n\n## Alternatives considered\n\n- a\n\n## Consequences\n\nx\n";

describe("normalizeChanged", () => {
	it("strips ./, dedupes, sorts", () => {
		expect(normalizeChanged(["./b.ts", "a.ts", "a.ts", " "] )).toEqual(["a.ts", "b.ts"]);
	});
});

describe("REVIEW_LINE_RE + isValidDate", () => {
	it("accepts canonical and same-day ordinal", () => {
		expect(REVIEW_LINE_RE.test("Review: FULL/2026-10-19/R1=ok R2=ok R3=ok")).toBe(true);
		expect(REVIEW_LINE_RE.test("Review: FULL/2026-10-19#2/R1=ok R2=ok R3=ok")).toBe(true);
	});

	it("rejects double-space, #0, fail values", () => {
		expect(REVIEW_LINE_RE.test("Review: FULL/2026-10-19/R1=ok  R2=ok R3=ok")).toBe(false);
		expect(REVIEW_LINE_RE.test("Review: FULL/2026-10-19#0/R1=ok R2=ok R3=ok")).toBe(false);
		expect(REVIEW_LINE_RE.test("Review: FULL/2026-10-19/R1=fail R2=ok R3=ok")).toBe(false);
	});

	it("validates calendar dates", () => {
		expect(isValidDate("2026-10-19")).toBe(true);
		expect(isValidDate("2026-13-01")).toBe(false);
		expect(isValidDate("not-a-date")).toBe(false);
	});
});

describe("headerZone", () => {
	it("cuts at the first ## heading", () => {
		const head = headerZone("# t\n\nStatus: implemented\n\nReview: FULL/2026-10-19/R1=ok R2=ok R3=ok\n\n## Problem\n\nx\n");
		expect(head.join("\n")).toContain("Review: FULL/2026-10-19/R1=ok R2=ok R3=ok");
		expect(head.join("\n")).not.toContain("## Problem");
	});
});

describe("classifyTier", () => {
	it("marks compose-root FULL", () => {
		const { full, reasons } = classifyTier(["src/index.ts"], root);
		expect(full).toBe(true);
		expect(reasons.some((r) => r.startsWith("compose-root"))).toBe(true);
	});

	it("marks gate-criteria FULL", () => {
		const { full, reasons } = classifyTier(["scripts/verify-layering.ts"], root);
		expect(full).toBe(true);
		expect(reasons.some((r) => r.startsWith("gate-criteria"))).toBe(true);
	});

	it("marks behavior-surface FULL", () => {
		for (const p of [".github/workflows/ci.yml", "docs/design.md", "templates/adr-proposed.md", "client/client.js", "evals/tasks/a.json", "evals/baseline/recall.json", "evals/README.md", "assets/skill.md"]) {
			expect(classifyTier([p], root).full).toBe(true);
		}
	});

	it("leaves machine-output eval runs LIGHT (首跑回填不触发 FULL)", () => {
		const { full, reasons } = classifyTier(["evals/runs/2026-10-19/compare.md"], root);
		expect(full).toBe(false);
		expect(reasons).toEqual([]);
	});

	it("bounds the runs exemption on the trailing slash", () => {
		expect(classifyTier(["evals/runs/report.json"], root).full).toBe(false);
		for (const p of ["evals/runs-evil/compare.md", "evals/runsbackfill.md"]) {
			expect(classifyTier([p], root).full).toBe(true);
		}
	});

	it("leaves ordinary src changes LIGHT", () => {
		expect(classifyTier(["src/services/foo.ts"], root).full).toBe(false);
		expect(classifyTier(["test/foo.test.ts"], root).full).toBe(false);
	});

	it("marks a proposed ADR promising 三重审核 FULL", () => {
		const repo = initRepo();
		try {
			write(repo, `${NOTES_DIR}/proposed/process/2026-10-19-y.md`, "# Agent Note: y\n\nStatus: proposed\n\n三重审核（R1/R2/R3）确认零行为变更\n");
			const { full, reasons } = classifyTier([`${NOTES_DIR}/proposed/process/2026-10-19-y.md`], repo);
			expect(full).toBe(true);
			expect(reasons.some((r) => r.startsWith("adr-promises-full"))).toBe(true);
		} finally {
			git(repo, "status");
		}
	});

	it("reads staged ADR bodies in staged mode (a worktree strip cannot downgrade FULL to LIGHT)", () => {
		const repo = initRepo();
		const rel = `${NOTES_DIR}/proposed/process/2026-10-19-y.md`;
		write(repo, rel, "# Agent Note: y\n\nStatus: proposed\n\n三重审核确认\n");
		// Strip the promising word in the worktree only (staged index keeps it).
		writeFileSync(join(repo, rel), "# Agent Note: y\n\nStatus: proposed\n\n普通改动\n");
		expect(classifyTier([rel], repo, { stagedOnly: true }).full).toBe(true);
		expect(classifyTier([rel], repo).full).toBe(false);
	});
});

describe("scanTier worktree git", () => {
	let cwd = "";
	let repo = "";

	beforeEach(() => {
		cwd = process.cwd();
		repo = initRepo();
		write(repo, "src/services/foo.ts", "// base\n");
		git(repo, "commit", "-qm", "init");
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(cwd);
	});

	it("LIGHT change passes without evidence", () => {
		writeFileSync(join(repo, "src/services/foo.ts"), "// changed\n");
		expect(scanTier(repo, { stagedOnly: false, since: undefined, head: "HEAD", changedFile: undefined })).toEqual([]);
	});

	it("FULL compose-root without evidence is blocked", () => {
		writeFileSync(join(repo, "src/index.ts"), "// x\n");
		const rows = scanTier(repo, { stagedOnly: false, since: undefined, head: "HEAD", changedFile: undefined });
		expect(rows.some((r) => r.includes("FULL-tier change lacks review evidence"))).toBe(true);
	});

	it("FULL passes when the same batch carries fresh evidence", () => {
		writeFileSync(join(repo, "src/index.ts"), "// x\n");
		write(repo, `${NOTES_DIR}/implemented/process/2026-10-19-x.md`, EVIDENCE);
		writeFileSync(join(repo, "src/index.ts"), "// x\n");
		const rows = scanTier(repo, { stagedOnly: false, since: undefined, head: "HEAD", changedFile: undefined });
		expect(rows).toEqual([]);
	});

	it("stale evidence re-armed by a touch does not clear (--since)", () => {
		write(repo, `${NOTES_DIR}/implemented/process/2026-10-19-x.md`, EVIDENCE);
		git(repo, "commit", "-qm", "evidence first");
		writeFileSync(join(repo, `${NOTES_DIR}/implemented/process/2026-10-19-x.md`), `${EVIDENCE}\n<!-- touched -->\n`);
		write(repo, "src/index.ts", "// brand new\n");
		git(repo, "commit", "-qm", "touch + new FULL");
		const rows = scanTier(repo, { stagedOnly: false, since: "HEAD~1", head: "HEAD", changedFile: undefined });
		expect(rows.some((r) => r.includes("FULL-tier change lacks review evidence"))).toBe(true);
	});

	it("an unresolvable --since base fails loud", () => {
		const rows = scanTier(repo, { stagedOnly: false, since: "nosuchref", head: "HEAD", changedFile: undefined });
		expect(rows.some((r) => r.includes("cannot determine the change set"))).toBe(true);
	});
});

describe("scanTier --changed-file (fixture mode)", () => {
	it("G3 violation sample is red, clean sample is green", () => {
		const violation = join(root, "test/fixtures/gates/review-tier/violation/changed.txt");
		const clean = join(root, "test/fixtures/gates/review-tier/clean/changed.txt");
		expect(readFileSync(violation, "utf-8")).toContain("src/index.ts");
		const bad = scanTier(join(root, "test/fixtures/gates/review-tier/violation"), {
			stagedOnly: false,
			since: undefined,
			head: "HEAD",
			changedFile: violation,
		});
		expect(bad.some((r) => r.includes("FULL-tier"))).toBe(true);
		const good = scanTier(join(root, "test/fixtures/gates/review-tier/clean"), {
			stagedOnly: false,
			since: undefined,
			head: "HEAD",
			changedFile: clean,
		});
		expect(good).toEqual([]);
	});
});
