# evals/ 回归集（P5a 格式 + 5 条种子）

任务级 fitness 的回归集：20–30 条是 RSI 目标，P5a 只落格式与 5 条种子（链路先通），全量归 P5b 补。

## 任务文件（`tasks/*.json`）

```jsonc
{
	"id": "task-001", // 全局唯一
	"from": "session-<id>#seq-<range>", // 脱敏溯源占位，不存私有原文
	"prompt": "<脱敏后的任务输入>",
	"expect": [
		// 判据（至少一条；判据优先级：可执行断言 > 结构化比对 > 人工 rubric > LLM judge）
		{ "kind": "file-exists", "path": "<相对路径>" },
		{ "kind": "test-pass", "cmd": "<命令>" },
		{ "kind": "output-contains", "any": ["<关键断言>"] }
	],
	"tags": ["memory", "conflict", "skill"], // negative 任务另带 "negative"
	"seed_memories": [
		// 本任务跑批时播进一次性库的记忆（user/feedback/reference 各类至少被全集覆盖）
		{ "id": "...", "type": "user", "title": "...", "description": "钩子", "body": "正文" }
	],
	"recall": {
		// 召回 A 的 fixture 子集：不写 query 即复用 prompt
		"query": "CI 没绿能发版吗",
		"expect_ids": ["release-gate-ci-green"],
		"negative": false // true = 断言零命中（expect_ids 必须为空）
	}
}
```

判据写不出的任务不入集（不用 LLM judge 硬凑）；主观维度只作观察项落 `OBSERVATION.md`。

## 基线（`baseline/recall.json`）

`eval:recall` 的逐 query 期望快照，提交进仓库。刷新路径唯一：`npm run eval:recall -- --update-baseline`，且同 PR 说明原因；手改无说明即打回。

## 产物（`runs/`，全 gitignore）

跑批明细留本地，只提交 `compare.md` 汇总与结论。卡片"上次四臂/外锚"读库内 `state` 键（`eval:last-four-arm` / `eval:last-external`），scheduled workflow 读 git log。

## 维护周期

自建集每 60 天（随外锚）替换 20%；外锚为 MemoryAgentBench AR/CR 子集 + Workspace-Bench-Lite，一年至少两份 `external-<date>.md`（目标 6 份），不与自建集混算。
