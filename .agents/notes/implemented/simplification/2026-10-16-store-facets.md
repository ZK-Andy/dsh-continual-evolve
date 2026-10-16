# Agent Note: 存储表面按域分面

Status: implemented

> 放置路径：`.agents/notes/implemented/simplification/2026-10-16-store-facets.md`

## Problem

`store-types.ts` 400 行顶格：`MemoryStore` 一个接口 60 个方法横跨 8 个域（记忆/技能/提示词分区、心跳、评审账目、管理），调用方被迫依赖整片表面（ISP 违规）。实现侧早已按六个 builder 拆分（`store.ts` 的 `build*Methods` + `createUsageCounters` + `createReviewAccounts`），类型侧没跟上，文件再加一行即红。

## Decision

- 新增 `src/store-facets.ts`（187 行）：六个分面接口（`MemoryPartition` / `SkillPartition` / `PromptPartition` / `UsageHeartbeat` / `ReviewAccounts` / `StoreAdmin`），与装配缝一一对应；`MemoryStore extends` 六者，组装与 40 个调用点零改动。
- `store-types.ts` 回 271 行：只留共享形状与常量，`MemoryStore` 经类型 re-export 兼容（编译期擦除，无运行时循环）。
- 新代码依赖最窄分面；`MemoryStore` 只做组装与兼容，不再加方法。

## Alternatives considered

- **不动（400 整也是绿）**：顶格即风险，任何形状新增先改预算再写码；且上帝接口违反单一职责已成事实。落败。
- **形状搬进各 `data/*` 描述符旁**：记录行（`records.ts`）已在 `data/`，但分面是组装契约，跟存储后端放一起会模糊 `store.ts` 装配根；且 `data/` 出度规则更严。落败。
- **改所有 40 个调用点用窄分面**：机械 churn 大而收益只在“好看”——窄分面供新代码用，老调用点随触碰自然迁移。落败。
- **把分面塞回 `store-types.ts` 只拆接口不拆文件**：文件仍顶格，预算悬崖还在。落败。

## Consequences

- 行为零变更：纯类型移动，491 测试全绿、`tsc` 全绿；门禁 52 模块全绿零警告。
- `store-types.ts` 悬崖解除（271 行）；`store-facets.ts` 187 行。
- 双语 README 布局行与 `store.ts` 头注已同步。
