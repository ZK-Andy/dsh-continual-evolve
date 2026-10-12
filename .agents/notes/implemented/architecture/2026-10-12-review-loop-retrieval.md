# Agent Note: 取回质量评审——token 记账唯一入口与判断审计面

Status: implemented

> 放置路径：`.agents/notes/implemented/architecture/2026-10-12-review-loop-retrieval.md`
> 前序：`.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md`（10-04 拆掉审计/快照/回滚/审批）；`docs/coding-standard.md` §3/§5 至今仍要求 `reviews.jsonl` 与 `token-usage.ts`，实现时两者皆空。收敛时用户加码：卡片展示一起做（无新路由，评审搭记忆快照的车）。

## Problem

评审环断了两处，审计语义靠运气：①每次提取的 token 用量以原始 JSON（`unknown`，20 余种键组合：`inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens/totalTokens` 时有时无）散落在 `extraction_log.usage` 里，无归一、无汇总、无唯一入口——新 LLM 调用点无处记账；②机械化判断（applied/rejected/skipped/failed）虽有行级账，但没有审计面：无人能回答“这周判了多少、拒了多少、花了多少 token”。

## Decision

SQLite 纪律下取回评审（无新表、无文件、不复活 jsonl）：

- **`src/token-usage.ts` 唯一入口**：`normalizeUsage(unknown)` 把 20 余种实测形状归一为 `{input, output, cacheRead, cacheWrite, reasoning, total}`（缺键为 0，`total` 缺失时推导），非法输入返回 null；`sumUsage` 纯累加。以后任何 LLM 调用点记账只走它。
- **判断审计面**：`store.reviewSummary(workspaceId, since?)` 只读聚合——按 status 计数、top 3 skip 原因（超长截断）、token 总量（经 `normalizeUsage`，坏 payload 单行跳过）。失败降级为零值，永不抛。
- **卡片展示搭记忆快照的车**：`MemorySnapshot.review` 随快照下发，无新路由、无新增请求；client 在统计行下加一行双语评审行（有判断才显示，`formatTokens` 紧凑显示总量）。
- **测试**：273 测试（含 9 个新增评审回归：归一形状/非法输入/聚合计数/since/坏 payload/降级/快照透出）/ typecheck / lint / 文档门禁全绿；覆盖率水位守住（`token-usage.ts` 100%）。

## Alternatives considered

- **复活 `reviews.jsonl`/`token-usage.jsonl` 文件**：10-04 拆的就是文件制（漂移、无门禁）；SQLite 时代行账已覆盖行级事实。落败。
- **每次调用一行用量明细表**：无界增长又要裁决；聚合查询已够评审用。落败（与 V2 `skill_usage` 同一理由）。
- **维持现状（原始 JSON + 人肉 SQL）**：用量不可比、不可总，新调用点继续各写各的。落败。
- **宿主侧计量 API**：宿主未暴露用量位，插件够不着。落败。

## Consequences

- 记账有唯一入口：`normalizeUsage` 覆盖真库全部 20 种实测形状；非法输入返回 null，不抛；`reviewSummary` 计数与手查 SQL 一致，空分区/坏库降级零值。
- 代价：快照多一次账本聚合查询（失败降级零值）；client 多一行展示（无判断时不渲染）。
- 诚实边界：用量只覆盖插件可观测的提取调用；宿主侧模型消耗不在账内。
- 验证：273 测试 / typecheck / lint / 文档门禁全绿；双语 README 同步（记账行为 + 273 徽章）。
- 后续：真库出现第 21 种形状时给归一函数补分支（测试锁死已观测形状，新形状由失败测试驱动）；分区行数大了以后给审计查询加索引（`since` 参数已预留）。
- 未恢复审批/回滚机制（10-04 的单人场景结论仍然有效）；只取回记账与审计。
