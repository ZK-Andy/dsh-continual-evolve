#!/usr/bin/env bash
# benchmark-trend.sh — D2 bootstrap 实验的数据提取工具。
# 遍历 <baseDir>/evolve/benchmarks/*/scoreboard.json，输出 per-benchmark 趋势表：
#   bid  label  status  overall  totalDurationMs  failedCells  caseHashes
# 用法: bash scripts/benchmark-trend.sh [bid ...]     （缺省 = 全部 benchmark）
# 依赖: node（JSON 解析，避免 jq 依赖）
BASE_DIR="${DSH_HOME:-$HOME/.dsh}"
ROOT="$BASE_DIR/evolve/benchmarks"

node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const want = process.argv.slice(2);
if (!fs.existsSync(root)) { console.error("no benchmarks under " + root); process.exit(0); }
let bids = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();
if (want.length > 0) bids = bids.filter((b) => want.includes(b));
console.log("bid\tlabel\tstatus\toverall\ttotalDurationMs\tfailedCells\tcaseHashes");
for (const bid of bids) {
  const boardPath = path.join(root, bid, "scoreboard.json");
  if (!fs.existsSync(boardPath)) { console.error(bid + "\t(no scoreboard)"); continue; }
  const b = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const emit = (label, status, entry) => {
    if (!entry) return;
    const failed = (entry.cells || []).filter((c) => c.status === "failed").length;
    const hashes = [...new Set((entry.cells || []).filter((c) => c.caseHash).map((c) => c.caseHash))].join(",");
    console.log([bid, label, status, entry.overall ?? "?", entry.aggregate?.totalDurationMs ?? "?", failed, hashes].join("\t"));
  };
  emit("reference", "reference", b.reference);
  for (const c of b.candidates || []) emit(c.label, "candidate", c);
}
' "$ROOT" "$@"