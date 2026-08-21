#!/usr/bin/env bash
# change-scope.sh — 输出变更范围（评审 / push 前的最小证据前置，替代 deepseek 原仓库的 change-scope）。
#
# 输出三部分：
#   base  /  head  —— 本次范围的两个锚点
#   commits      —— base..head 的提交列表
#   changed      —— 涉及的路径：已提交 diff + 工作区未暂存 diff + 未跟踪文件（dedupe）
#
# 用法：
#   ./scripts/change-scope.sh [<base-ref> [<head-ref>]]   # 显式指定；缺省自动取最近 fork-point
#   ./scripts/change-scope.sh                             # 自动推导 base
#
# 原则（来自 dsh-pre-push-checks 的最小证据）：绝不臆测 base，能用显式 ref 就用显式 ref；
# 自动推导仅作为便利，结果需人工确认。
set -euo pipefail

BASE=""
HEAD="${2:-HEAD}"
if [[ $# -ge 1 ]]; then
  BASE="$1"
else
  BASE="$(git merge-base --fork-point HEAD 2>/dev/null || true)"
  [[ -z "$BASE" ]] && BASE="$(git rev-list --max-parents=0 HEAD | tail -1 || true)"
  [[ -z "$BASE" ]] && { echo "error: 无法确定 base（仓库还没有历史？）" >&2; exit 1; }
fi

echo "== base:  $BASE  ($(git rev-parse --short "$BASE" 2>/dev/null || echo '?')${2:-})"
echo "== head:  $HEAD  ($(git rev-parse --short "$HEAD" 2>/dev/null || echo '?')${1:+ from arg})"
echo
echo "== commits ($BASE..$HEAD):"
git log --oneline "$BASE..$HEAD" || true
echo
echo "== changed paths:"
{
  git diff --name-only "$BASE...$HEAD" 2>/dev/null
  git diff --name-only
  git ls-files --others --exclude-standard
} | sort -u
