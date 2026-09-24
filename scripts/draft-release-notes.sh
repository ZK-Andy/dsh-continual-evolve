#!/usr/bin/env bash
# Draft bilingual GitHub Release notes from the commit range since the
# previous release tag (DSH release-notes shape, single-package trim).
#
# Usage: scripts/draft-release-notes.sh [prev-tag] [new-version]
#   prev-tag     default: newest reachable v* tag (full history when none)
#   new-version  default: package.json version
# Output: releases/v<new-version>.md (draft: EN section needs polishing,
#   author names need @handle replacement at publish time).
set -euo pipefail

cd "$(dirname "$0")/.."

PREV_TAG="${1:-$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)}"
NEW_VERSION="${2:-$(node -p "require('./package.json').version")}"
NEW_TAG="v${NEW_VERSION}"
OUT="releases/${NEW_TAG}.md"

if [ -n "$PREV_TAG" ]; then
	RANGE="$PREV_TAG..HEAD"
else
	RANGE="HEAD"
fi

# origin URL -> https compare base (no trailing .git).
REMOTE_URL="$(git config --get remote.origin.url || true)"
COMPARE_BASE="$(printf '%s' "$REMOTE_URL" | sed -e 's/\.git$//' -e 's|^git@github.com:|https://github.com/|')"
PKG_NAME="$(node -p "require('./package.json').name")"

feat=""; fix=""; other=""

while IFS='|' read -r hash author subject; do
	[ -n "$hash" ] || continue
	# The version-bump commit itself is release mechanics, not content.
	case "$subject" in
		chore\(release\)*) continue ;;
	esac
	# One bullet per commit; short hash stays as an audit comment.
	line="- ${subject} (@${author}) <!-- ${hash:0:7} -->"
	case "$subject" in
		feat*) feat+="${line}"$'\n' ;;
		fix*) fix+="${line}"$'\n' ;;
		*) other+="${line}"$'\n' ;;
	esac
done < <(git log "$RANGE" --reverse --format='%H|%an|%s')

mkdir -p releases
{
	printf '[中文](#cn-%s) | [English](#en-%s)\n' "$NEW_TAG" "$NEW_TAG"
	printf '\n<h3 id="cn-%s">新功能</h3>\n' "$NEW_TAG"
	printf '%s' "${feat:-$'- （无）\n'}"
	printf '\n### 问题修复\n'
	printf '%s' "${fix:-$'- （无）\n'}"
	printf '\n### 其他改动\n'
	printf '%s' "${other:-$'- （无）\n'}"
	printf '\n<!-- TODO: polish the English section before publishing -->\n'
	printf '\n<h3 id="en-%s">Features</h3>\n' "$NEW_TAG"
	printf '%s' "${feat:-$'- (none)\n'}"
	printf '\n### Bug Fixes\n'
	printf '%s' "${fix:-$'- (none)\n'}"
	printf '\n### Chores\n'
	printf '%s' "${other:-$'- (none)\n'}"
	printf '\nFull Changelog: [%s...%s](%s/compare/%s...%s)\n' \
		"${PREV_TAG:-root}" "$NEW_TAG" "$COMPARE_BASE" "${PREV_TAG:-$(git rev-list --max-parents=0 HEAD | head -n 1)}" "$NEW_TAG"
	printf 'npm: https://www.npmjs.com/package/%s/v/%s\n' "$PKG_NAME" "$NEW_VERSION"
} > "$OUT"

echo "draft written to $OUT (range: $RANGE)"
