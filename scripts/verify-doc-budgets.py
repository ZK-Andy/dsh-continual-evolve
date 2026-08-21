#!/usr/bin/env python3
"""Verify word budgets for standing docs, driven by a manifest JSON.

Manifest format (scripts/doc-budgets.manifest.json by default or passed via --manifest):
{
  "budgets": [
    {"path": "AGENTS.md", "max_words": 800},
    {"path": "docs/architecture.md", "max_words": 1200}
  ]
}
Entry paths are relative to the repo root where you run the check.

Missing file = violation (a budget entry without its file means the doc vanished
or the manifest is stale). Over-limit = violation with word count.

Usage:
  python3 verify-doc-budgets.py                 # manifest at ./scripts/doc-budgets.manifest.json
  python3 verify-doc-budgets.py --manifest <p>  # explicit manifest path
Exit code 0 = pass, 1 = violations.
"""

import argparse
import json
import re
import sys
from pathlib import Path

WORD_RE = re.compile(r"[\w\u4e00-\u9fff]+", re.UNICODE)


def count_words(text: str) -> int:
    body = re.sub(r"```.*?```", "", text, flags=re.DOTALL)  # skip code blocks
    body = re.sub(r"^\s*\|.*\|\s*$", "", body, flags=re.MULTILINE)  # skip tables
    return len(WORD_RE.findall(body))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="scripts/doc-budgets.manifest.json")
    args = ap.parse_args()

    manifest = Path(args.manifest)
    if not manifest.is_file():
        print(f"SKIP: manifest {manifest} not found")
        return 0
    data = json.loads(manifest.read_text(encoding="utf-8"))

    errors: list[str] = []
    for entry in data["budgets"]:
        doc = Path(entry["path"])
        limit = int(entry["max_words"])
        if not doc.is_file():
            errors.append(f"{doc}: budget entry but file missing (stale manifest?)")
            continue
        words = count_words(doc.read_text(encoding="utf-8"))
        status = "OK" if words <= limit else "FAIL"
        if status == "FAIL":
            errors.append(f"{doc}: {words} words > budget {limit} "
                          f"(relocate, condense, or raise ceiling with justification)")
        else:
            print(f"OK   {doc}: {words}/{limit}")

    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())