# evals/ 回归集（22 条任务，离线部分存活）

任务文件现仅服务离线 `eval:recall`（召回段）与 `eval-tasks --dry-run` 校验；合成四臂跑批已随 2026-10-20 simplification 移除。判据段（`expect`）与种子记忆（`seed_memories`）保留为历史形状，不再执行。任务集与召回基线都与 `scripts/` 同命运：只活在仓库里，发行包内没有读者，`package.json` 的 `files` 不再收录 `evals/tasks` 与 `evals/baseline`。

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

## 回放说明（查账先看 status 与裁剪）

`eval_cases` 表保留历史行（2026-10-19 首跑 176 行），停止写入；`eval:recall` 的 recall 段仍是活口径（见上）。`runs/2026-10-19/compare.md` 是那次跑批的留存读数，没有生产者——四臂 runner 已删，不要再指望它随新跑批次更新。

## 维护周期

外锚计划已取消（2026-10-20 simplification：一次没跑过，义务删除，workflow 只留离线 recall 月检）。`tasks/` 的 recall 段随 `eval:recall` 基线演进；任务集判据段冻结（跑批已死，不再替换 20%）。
