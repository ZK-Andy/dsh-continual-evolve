#!/usr/bin/env python3
"""Verify relative Markdown links: file targets exist and #fragment anchors resolve.

Checks, for every .md file under the given root (default: current directory):
  - `](relative/path.md)`  -> target file must exist
  - `](relative/path.md#slug)` -> target exists AND slug must match a heading
    slug (GitHub-style: lowercase, spaces->hyphens, strip punctuation) or an
    explicit <a id="slug"> anchor in that file
  - `](https://…)` / `](mailto:…)` / `](<…>)` -> skipped (external)
  - bare filenames or absolute paths are NOT validated here

By default, `skills/` and `node_modules/` directories are excluded: vendored
skill sources keep their upstream path references (see docs/ADAPTATION.md
section 3), and node_modules is third-party dependency content. Pass
--include-skills to check skills/ anyway.

Usage: python3 verify-md-links.py [root_dir] [--include-skills]
Exit code 0 = pass, 1 = violations.
"""

import argparse
import re
import sys
from pathlib import Path

LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
ANCHOR_RE = re.compile(r'<a\s+id="([^"]+)"')


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\u4e00-\u9fff \-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return text


def heading_slugs(path: Path) -> set[str]:
    slugs: set[str] = set()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return slugs
    for line in lines:
        m = HEADING_RE.match(line)
        if m:
            slugs.add(slugify(m.group(2)))
        m = ANCHOR_RE.search(line)
        if m:
            slugs.add(m.group(1))
    return slugs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--include-skills", action="store_true",
                    help="also check skills/ (vendored sources, upstream refs)")
    args = ap.parse_args()
    root = Path(args.root)
    errors: list[str] = []
    checked = 0
    for md in sorted(root.rglob("*.md")):
        if "node_modules" in md.parts:
            continue
        if not args.include_skills and "skills" in md.parts:
            continue
        text = md.read_text(encoding="utf-8")
        for target in LINK_RE.findall(text):
            target = target.strip()
            if target.startswith(("http://", "https://", "mailto:", "#", "<")):
                continue
            if "://" in target:
                continue
            if target.startswith("/"):  # repo-root absolute: resolve against root
                resolved = (root / target.lstrip("/")).resolve()
            else:
                resolved = (md.parent / target.split("#")[0]).resolve()
            if not resolved.is_file():
                errors.append(f"{md}: missing target '{target}'")
                continue
            checked += 1
            if "#" in target:
                frag = target.split("#", 1)[1]
                if frag and frag not in heading_slugs(resolved):
                    errors.append(f"{md}: dead anchor '#{frag}' in '{target}'")

    print(f"Checked {checked} link targets")
    if errors:
        for e in errors:
            print(f"FAIL: {e}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())