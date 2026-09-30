#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify the workspace HANDOFF family stays lean and layered.
 *
 * HANDOFF is a local working document family at the workspace root (the repo's
 * parent; local working docs, not part of the npm package):
 *
 *   HANDOFF.md         — entry file: stable sections + *summary* rolling window
 *   HANDOFF-todos.md   — action area: all todo items, lifecycle-constrained
 *   HANDOFF.archive.md — cold archive: full narrative of pre-window entries
 *
 * TS port of the gate originally adapted from dotnet-deepseek-harness-desktop
 * `scripts/verify-handoff-structure.py` (same gate shape: bounded window +
 * compressed todos + pointer/home pairing). Workspace differences:
 *
 *   * The family lives at the workspace root (repo parent), not the repo root —
 *     defaults resolve from this script's location, so cwd does not matter.
 *   * The cold archive is a single file (HANDOFF.archive.md), not per-month
 *     journal/todos-archive volumes; the pointer/home pair is checked against it.
 *   * Absent family in a clean CI checkout = nothing to guard (skip, like the
 *     desktop original's clean-CI semantics).
 *
 * Enforced:
 *   * `## 交接更新记录` window: entries <= --max-window (default 12), each
 *     <= --max-entry chars (default 260), format `- YYYY-MM-DD｜...`.
 *   * Required body sections exist (项目是什么/位置/当前状态/待办/开始步骤).
 *   * `## 待办` section is a pointer to HANDOFF-todos.md (must reference it).
 *   * Todos: `[ ]` <= --max-open (16) and <= --max-open-chars (340); `[x]`
 *     one-line pointers <= --max-closed (24) and <= --max-closed-chars (220).
 *   * Archive pair: HANDOFF.md must reference HANDOFF.archive.md; a referenced
 *     archive must exist; an existing archive must be referenced (no orphans).
 *
 * Usage: tsx scripts/verify-handoff-structure.ts [--handoff PATH] ...
 *        tsx scripts/verify-handoff-structure.ts --self-test  # offline fixtures
 * Exit code 0 = pass (or absent family), 1 = violations.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workspace root = repo root = this file's directory's parent's parent.
const WORKSPACE_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DEFAULT_HANDOFF_NAME = "HANDOFF.md";
const DEFAULT_TODOS_NAME = "HANDOFF-todos.md";
const DEFAULT_ARCHIVE_NAME = "HANDOFF.archive.md";
const DEFAULT_MAX_WINDOW = 12;
const DEFAULT_MAX_ENTRY = 260;
const DEFAULT_MAX_OPEN = 16;
const DEFAULT_MAX_CLOSED = 24;
const DEFAULT_MAX_OPEN_CHARS = 340;
const DEFAULT_MAX_CLOSED_CHARS = 220;

const REQUIRED_SECTIONS = ["项目是什么", "位置", "当前状态", "待办", "开始步骤"] as const;
const ENTRY_RE = /^- \d{4}-\d{2}-\d{2}｜/;
const SECTION_RE = /^## (?<name>.+?)\s*$/;
const ARCHIVE_RE = /HANDOFF\.archive\.md/;
const TODO_RE = /^- \[([ x])\] /;
const TODOS_REF_RE = /HANDOFF-todos\.md/;

interface ScanArgs {
	maxWindow: number;
	maxEntry: number;
	maxOpen: number;
	maxClosed: number;
	maxOpenChars: number;
	maxClosedChars: number;
}

interface ScanResult {
	windowCount: number;
	errors: string[];
}

/** Absent handoff = empty errors — clean-CI skip. */
export function scan(
	handoff: string,
	todosPath: string,
	archivePath: string,
	args: ScanArgs,
): ScanResult {
	if (!existsSync(handoff)) return { windowCount: 0, errors: [] }; // absent in a clean checkout: nothing to guard

	const errors: string[] = [];
	const text = readFileSync(handoff, "utf-8");
	const lines = text.split("\n");

	// 1) required body sections present
	const seenSections = new Set<string>();
	for (const line of lines) {
		const name = SECTION_RE.exec(line.trim())?.groups?.name;
		if (name !== undefined) {
			// tolerate a parenthetical suffix, e.g. "## 当前状态（1075 测试…）"
			const base = name.trim().split("（")[0] ?? name.trim();
			seenSections.add(base.split("(")[0]?.trim() ?? base);
		}
	}
	const missing = REQUIRED_SECTIONS.filter((s) => !seenSections.has(s));
	if (missing.length > 0) {
		errors.push(`${handoff}: missing required section(s): ${missing.join(", ")}`);
	}

	// 2) rolling-window entries: count bounded + each a short summary
	let windowCount = 0;
	let inWindow = false;
	lines.forEach((rawLine, idx) => {
		const line = rawLine.trim();
		if (line.startsWith("## 交接更新记录")) {
			inWindow = true;
			return;
		}
		if (inWindow && SECTION_RE.test(line)) {
			inWindow = false;
			return;
		}
		if (inWindow && ENTRY_RE.test(line)) {
			windowCount += 1;
			if (rawLine.length > args.maxEntry) {
				errors.push(
					`${handoff}: line ${idx + 1}: window entry exceeds ${args.maxEntry} chars (${rawLine.length}). Summaries only — full narrative goes to ${DEFAULT_ARCHIVE_NAME}.`,
				);
			}
		}
	});
	if (windowCount > args.maxWindow) {
		errors.push(
			`${handoff}: 交接更新记录 has ${windowCount} entries, exceeds max window ${args.maxWindow}. Archive the oldest summaries to ${DEFAULT_ARCHIVE_NAME} before adding to HANDOFF.`,
		);
	}

	// 3) `## 待办` section must point at the todos file
	let todosFound = false;
	let inTodo = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("## 待办")) {
			inTodo = true;
			continue;
		}
		if (inTodo && SECTION_RE.test(trimmed)) break;
		if (inTodo && TODOS_REF_RE.test(trimmed)) todosFound = true;
	}
	if (!todosFound) {
		errors.push(`${handoff}: \`## 待办\` section must reference the todos file (${DEFAULT_TODOS_NAME}).`);
	}

	// 4) todos file: exists + item counts/compression limits
	if (existsSync(todosPath)) {
		errors.push(...scanTodos(todosPath, args));
	} else if (todosFound) {
		errors.push(`${handoff}: referenced todos file missing: ${todosPath}`);
	} else {
		errors.push(`${handoff}: todos file missing: ${todosPath} (create ${DEFAULT_TODOS_NAME} for the action area).`);
	}

	// 5) archive pair, both directions: entry must name the cold archive, a
	// named archive must exist, and an existing archive must be named by the
	// entry or the todos file — a dropped pointer would orphan it silently.
	const referencedInEntry = ARCHIVE_RE.test(text);
	const referencedInTodos = existsSync(todosPath) && ARCHIVE_RE.test(readFileSync(todosPath, "utf-8"));
	const archiveExists = existsSync(archivePath);
	if (!referencedInEntry && !referencedInTodos) {
		errors.push(`${handoff}: no pointer to ${DEFAULT_ARCHIVE_NAME} — add one so pre-window narrative has a named home.`);
	}
	if (referencedInEntry && !archiveExists) {
		errors.push(`${handoff}: referenced archive not found: ${archivePath}`);
	}
	if (archiveExists && !referencedInEntry && !referencedInTodos) {
		errors.push(`${handoff}: ${DEFAULT_ARCHIVE_NAME} exists but is never named — add a pointer in HANDOFF.md or the todos file.`);
	}

	return { windowCount, errors };
}

/** Item budgets plus compression limits (one-line pointers when closed). */
function scanTodos(path: string, args: ScanArgs): string[] {
	const errors: string[] = [];
	const text = readFileSync(path, "utf-8");
	let openCount = 0;
	let closedCount = 0;
	text.split("\n").forEach((rawLine, idx) => {
		const m = TODO_RE.exec(rawLine);
		if (!m) return;
		if (m[1] === " ") {
			openCount += 1;
			if (rawLine.length > args.maxOpenChars) {
				errors.push(
					`${path}: line ${idx + 1}: open todo exceeds ${args.maxOpenChars} chars (${rawLine.length}). Keep action + trigger + pointer.`,
				);
			}
		} else {
			closedCount += 1;
			if (rawLine.length > args.maxClosedChars) {
				errors.push(
					`${path}: line ${idx + 1}: closed todo exceeds ${args.maxClosedChars} chars (${rawLine.length}). Compress to a one-line pointer — detail lives in the archive/ADR.`,
				);
			}
		}
	});
	if (openCount > args.maxOpen) {
		errors.push(`${path}: ${openCount} open items exceed max ${args.maxOpen} — finish or prune before adding more.`);
	}
	if (closedCount > args.maxClosed) {
		errors.push(
			`${path}: ${closedCount} closed pointers exceed the recent window of ${args.maxClosed} — move the oldest into the cold archive (${DEFAULT_ARCHIVE_NAME}) and leave a one-line pointer there.`,
		);
	}
	return errors;
}

interface SelfTestCase {
	desc: string;
	expected: number;
	entries?: string[];
	archiveRef?: boolean;
	archiveFile?: boolean;
	sections?: boolean;
	todos?: boolean;
	todoLines?: string[];
	todosRef?: boolean;
	/** Absent-handoff case: no HANDOFF.md written at all (clean-CI semantics). */
	absent?: boolean;
}

function selfTest(): number {
	const short = "- 2026-09-30｜**会话 t**：一句结论。";
	const longEntry = `- 2026-09-30｜**会话 t**：${"长".repeat(300)}`;
	const openTodo = "- [ ] 待办甲，行动+触发+指针。";
	const closedTodo = "- [x] 已办乙，一行指针。";
	const cases: SelfTestCase[] = [
		{ desc: "conforming (window + todos + archive pair)", expected: 0, todoLines: [openTodo, closedTodo] },
		{ desc: "window over max -> fail", expected: 1, entries: Array.from({ length: DEFAULT_MAX_WINDOW + 1 }, () => short), todoLines: [openTodo] },
		{ desc: "over-long window entry -> fail", expected: 1, entries: [longEntry], todoLines: [openTodo] },
		{ desc: "todos file missing -> fail", expected: 1, todos: false, todosRef: false },
		{ desc: "over-long open todo -> fail", expected: 1, todoLines: [`- [ ] ${"长".repeat(500)}`] },
		{ desc: "todos file not referenced from 待办 -> fail", expected: 1, todosRef: false, todoLines: [openTodo] },
		{ desc: "missing body sections -> fail", expected: 1, sections: false, todoLines: [openTodo] },
		{ desc: "too many open todos -> fail", expected: 1, todoLines: Array.from({ length: DEFAULT_MAX_OPEN + 1 }, (_, n) => `- [ ] 待办 ${n}。`) },
		{ desc: "no open items, closed ok -> pass", expected: 0, todoLines: [closedTodo] },
		{ desc: "closed pointers at window cap -> pass", expected: 0, todoLines: Array.from({ length: DEFAULT_MAX_CLOSED }, (_, n) => `- [x] 已办 ${n}。`) },
		{ desc: "closed pointers over window -> fail", expected: 1, todoLines: Array.from({ length: DEFAULT_MAX_CLOSED + 1 }, (_, n) => `- [x] 已办 ${n}。`) },
		{ desc: "archive referenced but missing -> fail", expected: 1, archiveFile: false, todoLines: [openTodo] },
		{ desc: "archive exists but never named -> fail", expected: 1, archiveRef: false, todoLines: [openTodo] },
		{ desc: "archive named only from todos -> pass", expected: 0, archiveRef: false, todoLines: [openTodo, `> 冷归档在 ${DEFAULT_ARCHIVE_NAME}。`] },
		{ desc: "absent handoff -> skip (clean-CI semantics)", expected: 0, absent: true },
	];

	let failed = 0;
	const td = mkdtempSync(join(tmpdir(), "handoff-gate-"));
	try {
		cases.forEach((c, i) => {
			const tree = join(td, `tree-${i}`);
			if (!c.absent) {
				mkdirSync(tree, { recursive: true });
				const {
					entries = [short],
					archiveRef = true,
					archiveFile = true,
					sections = true,
					todos = true,
					todoLines = [openTodo],
					todosRef = true,
				} = c;
				let lines = ["# HANDOFF — test", "", "## 交接更新记录", "", ...entries];
				if (sections) {
					lines.push("", "## 项目是什么", "", "正文。", "", "## 位置", "", "正文。", "", "## 当前状态", "", "正文。", "", "## 待办", "");
					if (todosRef) lines.push("> 行动区在 [HANDOFF-todos.md](HANDOFF-todos.md)。");
					lines.push("", "## 开始步骤", "", "正文。");
				}
				if (archiveRef) lines.push("", "> 历史全文在 [HANDOFF.archive.md](HANDOFF.archive.md)。");
				writeFileSync(join(tree, "HANDOFF.md"), `${lines.join("\n")}\n`, "utf-8");
				if (archiveFile) writeFileSync(join(tree, "HANDOFF.archive.md"), "# archive\n", "utf-8");
				if (todos) writeFileSync(join(tree, "HANDOFF-todos.md"), `${todoLines.join("\n")}\n`, "utf-8");
			}
			const { errors } = scan(
				join(tree, "HANDOFF.md"),
				join(tree, "HANDOFF-todos.md"),
				join(tree, "HANDOFF.archive.md"),
				{
					maxWindow: DEFAULT_MAX_WINDOW,
					maxEntry: DEFAULT_MAX_ENTRY,
					maxOpen: DEFAULT_MAX_OPEN,
					maxClosed: DEFAULT_MAX_CLOSED,
					maxOpenChars: DEFAULT_MAX_OPEN_CHARS,
					maxClosedChars: DEFAULT_MAX_CLOSED_CHARS,
				},
			);
			const actual = errors.length > 0 ? 1 : 0;
			if (actual === c.expected) {
				console.log(`  ok: ${c.desc}`);
			} else {
				console.log(`  ✗ ${c.desc}: expected exit ${c.expected}, got ${actual} (${errors.join(" ; ")})`);
				failed = 1;
			}
		});
	} finally {
		rmSync(td, { recursive: true, force: true });
	}
	console.log(failed === 0 ? "== verify-handoff-structure self-test passed ==" : "== verify-handoff-structure self-test failed ==");
	return failed;
}

function parseNum(argv: string[], flag: string, fallback: number): number {
	const i = argv.indexOf(flag);
	return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : fallback;
}

function main(): number {
	const argv = process.argv.slice(2);
	if (argv[0] === "--self-test") return selfTest();

	const handoffArgIdx = argv.indexOf("--handoff");
	const handoffArg = handoffArgIdx >= 0 ? argv[handoffArgIdx + 1] : undefined;
	const handoff = handoffArg ?? join(WORKSPACE_ROOT, DEFAULT_HANDOFF_NAME);
	if (!existsSync(handoff)) {
		console.log(`HANDOFF family absent at ${WORKSPACE_ROOT} — nothing to guard (OK)`);
		return 0;
	}
	const familyRoot = handoff.replace(/\/[^/]+$/, "");
	const { windowCount, errors } = scan(
		handoff,
		join(familyRoot, DEFAULT_TODOS_NAME),
		join(familyRoot, DEFAULT_ARCHIVE_NAME),
		{
			maxWindow: parseNum(argv, "--max-window", DEFAULT_MAX_WINDOW),
			maxEntry: parseNum(argv, "--max-entry", DEFAULT_MAX_ENTRY),
			maxOpen: parseNum(argv, "--max-open", DEFAULT_MAX_OPEN),
			maxClosed: parseNum(argv, "--max-closed", DEFAULT_MAX_CLOSED),
			maxOpenChars: parseNum(argv, "--max-open-chars", DEFAULT_MAX_OPEN_CHARS),
			maxClosedChars: parseNum(argv, "--max-closed-chars", DEFAULT_MAX_CLOSED_CHARS),
		},
	);
	console.log(`HANDOFF 交接更新记录 entries: ${windowCount}`);
	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log("OK");
	return 0;
}

process.exitCode = main();
