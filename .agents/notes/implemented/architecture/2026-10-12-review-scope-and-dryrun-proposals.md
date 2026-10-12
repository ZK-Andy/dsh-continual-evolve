# Agent Note: 评审的技能分区判据与试运行拟改稿留档

Status: implemented

## Problem

试运行（`review.dryRun` 默认开）跑起来后暴露两处偏差：

1. **技能 rubric 不分区**：技能评审统一要求「跨任务可复用、抹掉仓库名还成立」，项目分区（`skills.workspace_id <> ''`）的技能也照套。`ts-standards` 因此被判 quarantine——可它绑定本仓库的门禁命令与流程卡正是项目技能的设计意图，而它本来也只在 `/mnt/work/work` 分区生效。dry-run 下不落盘所以只是噪声，但关掉 dry-run 那天这条会直接把项目技能隐藏掉。
2. **试运行只留「为什么改」，不留「改成什么样」**：非落盘行只记 verdict 与理由，模型给出的 `title` / `description` / `body` 三件被丢弃（`review_log` 没有对应列）。人工评估试运行分布时看不到拟改稿，而拟稿质量恰恰是要判的东西——判改写 2 条、判隔离 1 条之后，能查的只有理由。

## Decision

- **技能评审按分区判**（`REVIEW_SKILL_SYSTEM_PROMPT`）：项目分区技能按①触发精度②正文可执行完备③同分区不重复三维判；「跨项目可复用」只对 `scope=global` 判。绑定本仓库路径/门禁/流程不再算缺陷；「放错家」重新定义为「`scope=global` 却绑定某仓库」。gate 与 evolve 两侧 prompt 都渲染 `scope=project|global` 行（`gatePrompt` 直接吃候选对象，`evolvePrompt` 显式传 `candidate.scope`），模型不必猜自己在评哪一档。
- **非落盘行留拟改稿**：`review_log` 增 `proposed TEXT` 列（旧库走单列 ALTER 迁移 `ensureReviewProposed`）。dry-run 的两条路径——rewrite、以及「幅度超限转隔离」——把模型给出的字段按 `{title, description, body, corrects}` 收进该列（只收实际出现过的字段；模型没给正文时列为 NULL）。落盘行不写这一列：改动本身就在记录里，重复存只会撑大账本。卡片暂不展示，先保证可 SQL 回查。

## Alternatives considered

- **给项目技能单开一套 system prompt**（按 kind+scope 选两套）：落败——多一套提示词要同步维护，而两者差别只有一个判据，写进同一段话更省。
- **把 scope 编进 `kind=` 字段**（如 `kind=skill:project`）：落败——`kind` 是解析与测试依赖的闭集，塞新维度会污染它；独立 `scope=` 行更直白。
- **拟改稿写进既有的 `reason` 字段**：落败——理由限 300 字且是给人读的一行话，塞全文会让 verdict 行不可读。
- **只在卡片里展示拟改稿（不加列）**：落败——卡片是请求时投影，试运行样本要能跨会话回查、可聚合统计；先落库，卡片展示留给后续。
- **落盘行也存一份拟改稿**：落败——改动已落在记录里（可 diff），重复存是冗余。

## Consequences

收益：试运行期人工能逐条看拟改稿（`SELECT proposed FROM review_log WHERE verdict IN ('rewrite','quarantine')`），关 dry-run 的决策有据可依；项目技能不再被「跨项目复用」误伤，而放错家判据反而更准（只盯全局分区）。
代价：一列 ALTER + 非落盘行多存一份正文（上限受单条正文 64KB 约束）。

### Testing

`test/review-prompt.test.ts`：两侧 prompt 渲染 `scope=`（记忆候选不带），rubric 载明项目分区规则。`test/review.test.ts`：dry-run rewrite 行带 `proposed.body`；dry-run 隔离（模型未给正文）该列为 NULL。`test/review-store.test.ts`：`proposed` 往返序列化 + 旧库迁移补列。
