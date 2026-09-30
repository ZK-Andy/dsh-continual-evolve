#!/usr/bin/env python3
"""Verify the workspace HANDOFF family stays lean and layered.

HANDOFF is a local working document family at the workspace root (the repo's
parent; gitignored-adjacent, not part of the npm package):

  HANDOFF.md        — entry file: stable sections + *summary* rolling window
  HANDOFF-todos.md  — action area: all todo items, lifecycle-constrained
  HANDOFF.archive.md — cold archive: full narrative of pre-window entries

Adapted from dotnet-deepseek-harness-desktop `scripts/verify-handoff-structure.py`
(same gate shape: bounded window + compressed todos + pointer/home pairing).
Workspace differences from the desktop original:

  * The family lives at the workspace root (repo parent), not the repo root —
    defaults resolve from this script's location, so cwd does not matter.
  * The cold archive is a single file (HANDOFF.archive.md), not per-month
    journal/todos-archive volumes; the pointer/home pair is checked against it.
  * Absent family in a clean CI checkout = nothing to guard (skip, like the
    desktop original's clean-CI semantics).

Enforced:
  * `## 交接更新记录` window: entries <= --max-window (default 12), each
    <= --max-entry chars (default 260), format `- YYYY-MM-DD｜...`.
  * Required body sections exist (项目是什么/位置/当前状态/待办/开始步骤).
  * `## 待办` section is a pointer to HANDOFF-todos.md (must reference it).
  * Todos: `[ ]` <= --max-open (16) and <= --max-open-chars (340); `[x]`
    one-line pointers <= --max-closed (24) and <= --max-closed-chars (220).
  * Archive pair: HANDOFF.md must reference HANDOFF.archive.md; a referenced
    archive must exist; an existing archive must be referenced (no orphans).

Usage: python3 scripts/verify-handoff-structure.py [--handoff PATH] ...
       python3 scripts/verify-handoff-structure.py --self-test  # offline fixtures
Exit code 0 = pass (or absent family), 1 = violations.
"""

import argparse
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# Workspace root = repo root = this file's parent's parent's parent.
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_HANDOFF_NAME = "HANDOFF.md"
DEFAULT_TODOS_NAME = "HANDOFF-todos.md"
DEFAULT_ARCHIVE_NAME = "HANDOFF.archive.md"
DEFAULT_MAX_WINDOW = 12
DEFAULT_MAX_ENTRY = 260
DEFAULT_MAX_OPEN = 16
DEFAULT_MAX_CLOSED = 24
DEFAULT_MAX_OPEN_CHARS = 340
DEFAULT_MAX_CLOSED_CHARS = 220

REQUIRED_SECTIONS = ("项目是什么", "位置", "当前状态", "待办", "开始步骤")
ENTRY_RE = re.compile(r"^- \d{4}-\d{2}-\d{2}｜")
SECTION_RE = re.compile(r"^## (?P<name>.+?)\s*$")
ARCHIVE_RE = re.compile(r"HANDOFF\.archive\.md")
TODO_RE = re.compile(r"^- \[([ x])\] ")
TODOS_REF_RE = re.compile(r"HANDOFF-todos\.md")


def _scan(handoff: Path, todos_path: Path, archive_path: Path,
          max_window: int, max_entry: int, max_open: int, max_closed: int,
          max_open_chars: int, max_closed_chars: int) -> tuple[int, list[str]]:
    """Return (window_count, errors). Absent handoff = (0, []) — clean-CI skip."""
    if not handoff.is_file():
        return 0, []  # absent in a clean checkout: nothing to guard

    errors: list[str] = []
    text = handoff.read_text(encoding="utf-8")
    lines = text.splitlines()

    # 1) required body sections present
    seen_sections: set[str] = set()
    for line in lines:
        m = SECTION_RE.match(line.strip())
        if m:
            name = m.group("name").strip()
            base = name.split("（")[0].split("(")[0].strip()
            seen_sections.add(base)
    missing = [s for s in REQUIRED_SECTIONS if s not in seen_sections]
    if missing:
        errors.append(f"{handoff}: missing required section(s): {missing}")

    # 2) rolling-window entries: count bounded + each a short summary
    window_count = 0
    in_window = False
    for i, line in enumerate(lines, 1):
        if line.strip().startswith("## 交接更新记录"):
            in_window = True
            continue
        if in_window and SECTION_RE.match(line.strip()):
            in_window = False
            continue
        if in_window and ENTRY_RE.match(line.strip()):
            window_count += 1
            if len(line) > max_entry:
                errors.append(
                    f"{handoff}: line {i}: window entry exceeds {max_entry} "
                    f"chars ({len(line)}). Summaries only — full narrative "
                    f"goes to {archive_path.name}.")
    if window_count > max_window:
        errors.append(
            f"{handoff}: 交接更新记录 has {window_count} entries, exceeds max "
            f"window {max_window}. Archive the oldest summaries to "
            f"{archive_path.name} before adding to HANDOFF.")

    # 3) `## 待办` section must point at the todos file
    todos_found = False
    in_todo = False
    for line in lines:
        if line.strip().startswith("## 待办"):
            in_todo = True
            continue
        if in_todo and SECTION_RE.match(line.strip()):
            break
        if in_todo and TODOS_REF_RE.search(line):
            todos_found = True
    if not todos_found:
        errors.append(
            f"{handoff}: `## 待办` section must reference the todos file "
            f"({todos_path.name}).")

    # 4) todos file: exists + item counts/compression limits
    if todos_path.is_file():
        errors.extend(_scan_todos(todos_path, max_open, max_closed,
                                  max_open_chars, max_closed_chars))
    elif todos_found:
        errors.append(f"{handoff}: referenced todos file missing: {todos_path}")
    else:
        errors.append(f"{handoff}: todos file missing: {todos_path} "
                      f"(create {todos_path.name} for the action area).")

    # 5) archive pair, both directions: entry must name the cold archive, a
    # named archive must exist, and an existing archive must be named by the
    # entry or the todos file — a dropped pointer would orphan it silently.
    referenced_in_entry = bool(ARCHIVE_RE.search(text))
    referenced_in_todos = (todos_path.is_file()
                           and bool(ARCHIVE_RE.search(todos_path.read_text(encoding="utf-8"))))
    archive_exists = archive_path.is_file()
    if not (referenced_in_entry or referenced_in_todos):
        errors.append(
            f"{handoff}: no pointer to {archive_path.name} — add one so "
            f"pre-window narrative has a named home.")
    if referenced_in_entry and not archive_exists:
        errors.append(f"{handoff}: referenced archive not found: {archive_path}")
    if archive_exists and not (referenced_in_entry or referenced_in_todos):
        errors.append(f"{handoff}: {archive_path} exists but is never named — "
                      f"add a pointer in HANDOFF.md or the todos file.")
    return window_count, errors


def _scan_todos(path: Path, max_open: int, max_closed: int,
                max_open_chars: int, max_closed_chars: int) -> list[str]:
    """Item budgets plus compression limits (one-line pointers when closed)."""
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    open_count = closed_count = 0
    for i, line in enumerate(text.splitlines(), 1):
        m = TODO_RE.match(line)
        if not m:
            continue
        state = m.group(1)
        if state == " ":
            open_count += 1
            if len(line) > max_open_chars:
                errors.append(
                    f"{path}: line {i}: open todo exceeds {max_open_chars} "
                    f"chars ({len(line)}). Keep action + trigger + pointer.")
        else:
            closed_count += 1
            if len(line) > max_closed_chars:
                errors.append(
                    f"{path}: line {i}: closed todo exceeds {max_closed_chars} "
                    f"chars ({len(line)}). Compress to a one-line pointer — "
                    f"detail lives in the archive/ADR.")
    if open_count > max_open:
        errors.append(f"{path}: {open_count} open items exceed max {max_open} "
                      f"— finish or prune before adding more.")
    if closed_count > max_closed:
        errors.append(
            f"{path}: {closed_count} closed pointers exceed the recent window "
            f"of {max_closed} — move the oldest into the cold archive "
            f"({DEFAULT_ARCHIVE_NAME}) and leave a one-line pointer there.")
    return errors


def _self_test() -> int:
    """Offline fixture self-check built from synthetic HANDOFF trees."""
    short = "- 2026-09-30｜**会话 t**：一句结论。"
    long_entry = "- 2026-09-30｜**会话 t**：" + "长" * 300
    open_todo = "- [ ] 待办甲，行动+触发+指针。"
    closed_todo = "- [x] 已办乙，一行指针。"

    @dataclass
    class Case:
        """One synthetic HANDOFF tree plus the exit code it must produce."""

        desc: str
        expected: int
        entries: list[str] = field(default_factory=lambda: [short])
        archive_ref: bool = True
        archive_file: bool = True
        sections: bool = True
        todos: bool = True
        todo_lines: list[str] = field(default_factory=lambda: [open_todo])
        todos_ref: bool = True

    def build(tree: Path, case: Case) -> None:
        lines = ["# HANDOFF — test\n", "\n", "## 交接更新记录\n", "\n"]
        for e in case.entries:
            lines.append(e + "\n")
        if case.sections:
            lines.append("\n## 项目是什么\n\n正文。\n")
            lines.append("\n## 位置\n\n正文。\n")
            lines.append("\n## 当前状态\n\n正文。\n")
            lines.append("\n## 待办\n\n")
            if case.todos_ref:
                lines.append("> 行动区在 [HANDOFF-todos.md](HANDOFF-todos.md)。\n")
            lines.append("\n## 开始步骤\n\n正文。\n")
        if case.archive_ref:
            lines.append("\n> 历史全文在 [HANDOFF.archive.md](HANDOFF.archive.md)。\n")
        (tree / "HANDOFF.md").write_text("".join(lines), encoding="utf-8")
        if case.archive_file:
            (tree / "HANDOFF.archive.md").write_text("# archive\n", encoding="utf-8")
        if case.todos:
            (tree / "HANDOFF-todos.md").write_text(
                "".join(t + "\n" for t in case.todo_lines), encoding="utf-8")

    cases = [
        Case("conforming (window + todos + archive pair)", 0,
             todo_lines=[open_todo, closed_todo]),
        Case("window over max -> fail", 1,
             entries=[short] * (DEFAULT_MAX_WINDOW + 1), todo_lines=[open_todo]),
        Case("over-long window entry -> fail", 1,
             entries=[long_entry], todo_lines=[open_todo]),
        Case("todos file missing -> fail", 1, todos=False, todos_ref=False),
        Case("over-long open todo -> fail", 1,
             todo_lines=["- [ ] " + "长" * 500]),
        Case("todos file not referenced from 待办 -> fail", 1,
             todos_ref=False, todo_lines=[open_todo]),
        Case("missing body sections -> fail", 1, sections=False,
             todo_lines=[open_todo]),
        Case("too many open todos -> fail", 1,
             todo_lines=[f"- [ ] 待办 {n}。" for n in range(DEFAULT_MAX_OPEN + 1)]),
        Case("no open items, closed ok -> pass", 0, todo_lines=[closed_todo]),
        Case("closed pointers at window cap -> pass", 0,
             todo_lines=[f"- [x] 已办 {n}。" for n in range(DEFAULT_MAX_CLOSED)]),
        Case("closed pointers over window -> fail", 1,
             todo_lines=[f"- [x] 已办 {n}。"
                         for n in range(DEFAULT_MAX_CLOSED + 1)]),
        Case("archive referenced but missing -> fail", 1,
             archive_file=False, todo_lines=[open_todo]),
        Case("archive exists but never named -> fail", 1,
             archive_ref=False, todo_lines=[open_todo]),
        Case("archive named only from todos -> pass", 0,
             archive_ref=False, archive_file=True,
             todo_lines=[open_todo, f"> 冷归档在 {DEFAULT_ARCHIVE_NAME}。"]),
        Case("absent handoff -> skip (clean-CI semantics)", 0, sections=False,
             todos=False, todo_lines=[]),
    ]

    # The absent-handoff case gets no HANDOFF.md written at all.
    failed = 0
    with tempfile.TemporaryDirectory() as td:
        for i, case in enumerate(cases):
            tree = Path(td) / f"tree-{i}"
            tree.mkdir(parents=True, exist_ok=True)
            if case.desc.startswith("absent handoff"):
                _, errors = _scan(tree / "HANDOFF.md", tree / "HANDOFF-todos.md",
                                  tree / "HANDOFF.archive.md", DEFAULT_MAX_WINDOW,
                                  DEFAULT_MAX_ENTRY, DEFAULT_MAX_OPEN,
                                  DEFAULT_MAX_CLOSED, DEFAULT_MAX_OPEN_CHARS,
                                  DEFAULT_MAX_CLOSED_CHARS)
            else:
                build(tree, case)
                _, errors = _scan(tree / "HANDOFF.md", tree / "HANDOFF-todos.md",
                                  tree / "HANDOFF.archive.md", DEFAULT_MAX_WINDOW,
                                  DEFAULT_MAX_ENTRY, DEFAULT_MAX_OPEN,
                                  DEFAULT_MAX_CLOSED, DEFAULT_MAX_OPEN_CHARS,
                                  DEFAULT_MAX_CLOSED_CHARS)
            actual = 1 if errors else 0
            if actual == case.expected:
                print(f"  ok: {case.desc}")
            else:
                print(f"  ✗ {case.desc}: expected exit {case.expected}, got "
                      f"{actual} ({' ; '.join(errors)})")
                failed = 1
    if failed == 0:
        print("== verify-handoff-structure self-test passed ==")
    else:
        print("== verify-handoff-structure self-test failed ==", file=sys.stderr)
    return failed


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        return _self_test()

    parser = argparse.ArgumentParser(description="Verify workspace HANDOFF family structure")
    parser.add_argument("--handoff", default=str(WORKSPACE_ROOT / DEFAULT_HANDOFF_NAME))
    parser.add_argument("--max-window", type=int, default=DEFAULT_MAX_WINDOW)
    parser.add_argument("--max-entry", type=int, default=DEFAULT_MAX_ENTRY)
    parser.add_argument("--max-open", type=int, default=DEFAULT_MAX_OPEN)
    parser.add_argument("--max-closed", type=int, default=DEFAULT_MAX_CLOSED)
    parser.add_argument("--max-open-chars", type=int, default=DEFAULT_MAX_OPEN_CHARS)
    parser.add_argument("--max-closed-chars", type=int, default=DEFAULT_MAX_CLOSED_CHARS)
    args = parser.parse_args()

    handoff = Path(args.handoff)
    family_root = handoff.parent
    todos = family_root / DEFAULT_TODOS_NAME
    archive = family_root / DEFAULT_ARCHIVE_NAME
    if not handoff.is_file():
        print(f"HANDOFF family absent at {family_root} — nothing to guard (OK)")
        return 0
    count, errors = _scan(handoff, todos, archive, args.max_window, args.max_entry,
                          args.max_open, args.max_closed, args.max_open_chars,
                          args.max_closed_chars)
    print(f"HANDOFF 交接更新记录 entries: {count}")
    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
