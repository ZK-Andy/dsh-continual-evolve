# Agent Note: P4生命周期开工重估（三项递延定死 + 拆 P4-a/b）

Status: implemented

> 放置路径：本文件（`.agents/notes/implemented/feature/2026-10-19-p4-lifecycle-rescope.md`）。
> 上游输入：总纲 `docs/plans/2026-10-19-architecture-supplement-plan.md` §2 D9 + §3 P4 + §7.5
> 与归档可见性 ADR（`.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md`，执行入口）。
> P4-a 落地内容：`archive_reason` + `merged_into` 两列、三写路径 stamped 原因、同会话版本行合并
>（`src/services/memory-merge.ts`）、卡片只读归档区、回填脚本、G6 补口（memories 入 guard）。
> P4-b 遗留：普通 update 语义统一（含 corrects/usage/review 三处跟随迁移）。

## Problem

总纲 §7.5 递延三项（判定规则、回链字段与主键、合并上限）在开工前定死；D9 要求去重版本行与普通
update 同语义；G6 实测只覆盖三表，memories 在快照之外——三者都是 P4-a 的开工输入。

## Decision

### D1 同主题判定：P4-a 纯机械，与既有轨道融合、不新增 LLM 调用

P4 不新增任何 LLM 调用与新队列。去重智能住在既有 propose 调用里（`extraction-propose.ts`：
manifest 50 行 + candidates 8 篇全文 + 提示词"已有记忆的状态变了，提案 update 改原条目；
新旧并存比没有记忆更糟"，模型用既有 id 提案 update/delete 即去重）；P4 只把落盘侧从
"原地覆盖"换成"版本行"，是写门禁的延伸，不是新轨。

- **M1 同 id**：提案 id 命中同分区 active 行 → **丢弃半已存在**：
  body 归一化等价的 create 由 `pre-screen.ts` 的 `duplicate` 拒因丢弃、无实质变化的 update
  由 `no-change` 拒因丢弃（P2 已落地，P4-a 复用，不重建）；**P4-a 只新增合并半**：
  有实质变化 → 版本行合并（旧行归档 `merged-duplicate`、回链新 id；新行 id = `<base>-vN`）。
- **M2 同会话同题**：同 workspace + 同 type + 归一化标题相等 + `source_session` 相等 → 同主题，
  走同一版本行合并（补 propose 调用认不出的机械缺口：标题微调但同题）。
- **跨 id 跨标题的语义重复**：归 propose prompt/候选迭代（既有调用内的提示词与
  `candidateRecords` 调优，不单独立项、不新增调用）；`similar` 联动（`memory-linkage.ts` 落盘即
  搜邻 → review 复看）覆盖第二双眼睛，P4 不碰评审 verdict 枚举。
- **归一化函数复用 `pre-screen.ts` 的 `normalize` 同一家**（P4-a 在同函数内扩展 `NFC` +
  `\r\n?`→`\n`），不另建比较函数；`changesNothing` 的字段集（title/description/
  body/notWhen）即"实质变化"口径，P4-a 沿用。
- **普通 update 保持原地**（不刷新来源列，P1 语义）：合并只吃创作路径
  （`item-review` 触发除外——评审是第二作者，其复写永远原地，这是既有契约），与版本行并存
  记为 P4-a 有期例外，P4-b 统一（含三处跟随迁移）。理由见 Alternatives。

### D2 版本链指针与主键策略

- 新增两列：`archive_reason TEXT NOT NULL DEFAULT ''`（P4-a 四值：
  `promoted-source` / `review-archive` / `demoted-source` / `merged-duplicate`；`''` = 未分类迁移占位，
  卡片显"—"）+ `merged_into TEXT`（NULL，仅 `merged-duplicate` 行写新行 id，同分区）。
- 旧行**原地归档**（`status` + `updated_at` + `archive_reason` + `merged_into` 同一事务），新行全新 id；
  碰撞时 `-vN` 递增（扫描同分区 active + archived 取最大 N + 1）——**主键不冲突由构造保证**，
  无需删旧 PK。
- 不复用 `corrects` 列（修正指向语义，不混）；新行不存回指（正向链 + 账本 before/after 足够，
  同归档可见性 ADR "不另建账本"立场）。
- 迁移沿既有风格：`SCHEMA_DDL` 经 `memoriesDdl()` 单一家 + `ensureMemoriesArchiveColumns`
  （一批两列，幂等 ALTER）；回填独立脚本按判词投影已知原因（分区感知优先级：全局行先认来源分区 `demote`
  判词、再认全局 `promote` 判词；工作区分区行先认本区 applied `archive` 判词、再认全局 `promote`
  判词——`demote` 判词住来源分区而 `promote` 住全局，迟到的降级不被早到的提级证据淹没），
  无法判定留 `''`。
- 合并守卫：旧行若被 `corrects` 指向（沿 `archiveGateReason` 门槛）→ 拒绝合并、记拒因，不强并
 （悬空指针比"合并不成"贵）。

### D3 合并上限（首版钉死，可棘轮）

- 单次合并恰一源一新（M1/M2 皆 1:1，由构造保证，≤5 恒成立，无需计数器）；总输入字符
  **≤8000**（`MERGE_INPUT_CHAR_CAP`，超限走原地/原失败的老路，不抛错——合并是历史保留优化，
  不是正确性门槛），新 body 受 schema 既有 64KB cap；超限拆批对 1:1 不适用（每批独立事务已由
  `applyProposals` 保证）。
- LLM 失败路径**零删除**（fail-closed 既有纪律）；空白级 diff 不触发删除/合并。
- **staged 快照评估结论：不做新快照机制**——提级/合并走单事务 + 回滚既有；before/after 已在
  `extraction_log.files` 与 `review_log.proposed`；归档行本身即快照；新增 hash 账本是第二套账
  （同归档可见性 ADR Alternative 2 论据）。D2 不做 UI 恢复保持。结论落本 ADR，不悬置。

### D4 卡片归档区（只读投影，不开写入口）

- `store.listArchived(workspaceId, 50)` + `memorySnapshot.archived[]`：
  `{id, title, reason（空→"—"）, mergedInto?, updatedAt}`；上限 50、默认折叠置底、无操作按钮、
  `mergedInto` 纯文本（非链接，可抄不可点）。
- 走 `pages/memory-card/` 只读投影；恢复仍走账本快照既有能力（D2 立场不变）。

### D5 G6 先行补口（P4 列落地的前置）

- 在 P4 列落地前，把 `memories` 表 DDL（至少列集 + `archive_reason` 白名单）纳入
  `verify-schema-snapshot` 覆盖并 `--update` 重定基线；否则"漏迁移即红"对 P4 无效。
- 脚本自身变更走 G3 红绿俱验纪律（G-batch 已收官，可直接用）。

### D6 分期与工时（原 3 天为 D9 扩大前占位，超限拆分）

| 期 | 内容 | 工时 |
|---|---|---|
| P4-a | 单 ensure + 回填脚本与测试；机械去重（M1/M2 + `-vN` + `merged_into` 同事务）与条件删除归一化；卡片归档区（含 client 折叠区）；G6 补口；本 ADR | 2.5 天 |
| P4-b | 普通 update 语义统一（含 corrects/usage/review 三处跟随迁移）；跨标题识别归 propose
prompt/候选迭代（既有调用内调优，不单独立项） | 1–1.5 天 |

## Alternatives considered

- **跨 id 语义去重也在 P4-a（LLM 判）**：多一次 LLM 调用（费用 + flaky 判定），且无 P5 召回数据支撑阈值；
  误合并 = 误删类事故，正撞"误删保护"主线。落败：递延 P4-b。
- **普通 update 立即统一为版本行**：corrects 目标悬空、usage 按旧 id 孤儿、review 历史按 item_id 断裂，
  三处跟随迁移超预算。落败：P4-b 专款，P4-a 记有期例外（非临时兜底，是范围切分，根因与代价已列上条）。
- **回链复用 `corrects` / 编进 reason 文本**：`corrects` 有校验语义（存在/active/非自指），reason 是判词文本；
  混用一次，读者永远要猜。落败：单列 `merged_into`。
- **新旧行同 id（删旧 PK 复用）**：失去审计行，归档区无物可列，与 P4 验收（旧行归档区可见）直接冲突。
  落败：`-vN` 后缀（CJK-hash 回退标题的互操作写进 `memory-rules` 测试）。
- **staged hash 快照新机制**：第二套账本（归档可见性 ADR Alternative 2 同一论据），既有事务 + before/after 已够。
  落败：不做，结论落此 ADR。
- **合并无上限**：单事务膨胀 + 账本不可读；8k ≈ 2× 注入索引预算（4000 token），类比失守。落败：1:1 构造 + 8k 钉死、可棘轮。

## Consequences

- `-vN` 后缀与 slug 派生（含 CJK-hash 回退）的互操作——规则与用例锁进 `memory-merge` 测试。
- P4-a 的 update/版本行双轨是 D9 字面例外——已在此 ADR 记期、记根因、记 P4-b 统一项，不散在会话里。
- `verify-schema-snapshot` 自身扩展——走 G3 红绿俱验，不靠人工目检。
