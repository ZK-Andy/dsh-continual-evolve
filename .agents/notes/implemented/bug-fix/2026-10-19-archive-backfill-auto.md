# Agent Note: 归档原因回填随迁移自动跑

Status: implemented

> 放置路径：本文件（`.agents/notes/implemented/bug-fix/2026-10-19-archive-backfill-auto.md`）。
> 上游输入：P4 生命周期 ADR（`.agents/notes/implemented/feature/2026-10-19-p4-lifecycle-rescope.md` D2，当时定的是独立手动脚本）。

## Problem

P4-a 给已归档老行补 `archive_reason` 的方案是独立手动脚本（`scripts/backfill-archive-reason.ts --db`），用户必须自己找出来跑。源码分发下这是断层：npm 用户更新完不会翻 ADR 找脚本，老归档行就永远显示 `—`，且每个用户都要手跑一次。

## Decision

`migrateDatabase` 尾部（列齐 + `rebuildDriftedTables` 之后）每次同步调用 `backfillArchiveReasons`，随每次开库自动跑。回填只写 `archive_reason=''` 的已归档行、无证据留空、单事务幂等，空库与已回填库都是零操作。手动脚本保留为诊断/重跑逃生口，头注释写明日常用户不再需要它。`ensureMemoriesArchiveColumns` 的注释同步改掉"等手动脚本"的说法。

## Alternatives considered

- **保持手动 + 文档里加粗提醒**：提醒救不了分发断层，用户不读 ADR，升级后静默留 `—`。落败：把机械迁移推给人是本末倒置。
- **state 键只跑一次**：回填查询本身已是 `WHERE archive_reason=''` 自限，空操作成本一次 SELECT，无需第二套"跑过没有"的状态。落败：多余状态多余分支。
- **卡片读取时惰性回填**：读路径写库违反存储单写者与只读投影纪律，且并发读会争写。落败：迁移时一次做对。
- **mount 后台异步跑**：回填是纯本地 SQL、毫秒级，同步跑无体感；异步反而引入"卡片先看到 `—`、稍后才有原因"的闪烁。落败：同步即够。

## Consequences

- 老用户升级后首次 mount 自动补齐原因，无需任何手动步骤；判不出来的行继续留 `''` 显示 `—`，与此前语义一致。
- 每次开库多一次"查无 `''` 行即返"的 SELECT + 无操作事务，成本可忽略。
- `scripts/backfill-archive-reason.ts` 语义不变（先 migrate 再回填，重复跑安全），测试加一条"关库重开自动回填"的回归用例。
