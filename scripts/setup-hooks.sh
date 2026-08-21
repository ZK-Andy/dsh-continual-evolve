#!/usr/bin/env bash
# setup-hooks.sh — 配置 git 使用 .githooks
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git config core.hooksPath .githooks
echo "git hooks 已指向 .githooks (core.hooksPath=.githooks)"
ls -l .githooks/
