#!/usr/bin/env python3
"""Verify Agent Note (ADR) format: header block, skeleton, status-directory consistency.

Checks, for every .md under .agents/notes/ (excluding archived/ and .zh.md files):
  1. Line 1 is "# Agent Note: <title>"; the "Status: <status>" line follows the
     title, and a blank line between title and Status is allowed — this matches
     the real deepseek-harness note convention (fixed 2026-08-20)
  2. Status value matches the lifecycle folder (proposed/implemented/rejected)
  3. Required skeleton sections exist (## Problem, ## Alternatives considered,
     plus lifecycle-specific: ## Decision/## Consequences for implemented,
     ## Proposal for proposed)
  4. implemented notes must NOT contain spec-speak headings
     (## Proposal / ## Plan / ## Migration plan / ## Acceptance criteria)

Usage: python3 verify-adr-format.py [notes_root]
Exit code 0 = pass, 1 = violations found.
"""

import re
import sys
from pathlib import Path

HEADER_RE = re.compile(r"^# Agent Note: .+$")
STATUS_RE = re.compile(r"^Status: (proposed|implemented|rejected(?: — .+)?)$")
STATUS_BY_DIR = {"proposed": "proposed", "implemented": "implemented", "rejected": "rejected"}
BANNED_IN_IMPLEMENTED = ("## Proposal", "## Plan", "## Migration plan", "## Acceptance criteria")
REQUIRED_ALL = ("## Problem", "## Alternatives considered")
REQUIRED_IMPLEMENTED = ("## Decision", "## Consequences")
REQUIRED_PROPOSED = ("## Proposal",)


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".agents/notes")
    if not root.is_dir():
        print(f"SKIP: {root} does not exist (no Agent Notes tree)")
        return 0

    errors: list[str] = []
    checked = 0
    for note in sorted(root.rglob("*.md")):
        rel = note.relative_to(root)
        parts = rel.parts
        if "archived" in parts or note.name.endswith(".zh.md"):
            continue
        lifecycle = parts[0] if parts else ""
        if lifecycle not in STATUS_BY_DIR:
            continue
        checked += 1
        text = note.read_text(encoding="utf-8")
        lines = text.splitlines()

        if not lines or not HEADER_RE.match(lines[0]):
            errors.append(f"{rel}: line 1 must be '# Agent Note: <title>'")
        # 真实约定（deepseek 仓库实际笔记）：标题后可空一行，再跟 Status 行。
        status_line = next((l for l in lines[1:] if l.strip()), "")
        status_m = STATUS_RE.match(status_line)
        if status_m is None:
            errors.append(f"{rel}: must contain 'Status: <proposed|implemented|rejected>' after the title")
        elif status_m.group(1) != lifecycle:
            errors.append(f"{rel}: Status '{status_m.group(1)}' "
                          f"mismatches folder '{lifecycle}'")

        for sec in REQUIRED_ALL:
            if not any(l.strip() == sec for l in lines):
                errors.append(f"{rel}: missing required section '{sec}'")

        if lifecycle == "implemented":
            for sec in REQUIRED_IMPLEMENTED:
                if not any(l.strip() == sec for l in lines):
                    errors.append(f"{rel}: missing required section '{sec}'")
            for banned in BANNED_IN_IMPLEMENTED:
                if any(l.strip() == banned for l in lines):
                    errors.append(f"{rel}: implemented note must not contain '{banned}'")
        elif lifecycle == "proposed":
            for sec in REQUIRED_PROPOSED:
                if not any(l.strip() == sec for l in lines):
                    errors.append(f"{rel}: missing required section '{sec}'")

    print(f"Checked {checked} Agent Notes")
    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())