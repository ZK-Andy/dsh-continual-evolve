# Agent Note: 统一提取回执与 session-close 有界 drain

Status: implemented

## Problem

memory phase 的结局只进 `plugin.log`（`reviews.jsonl` 无行）：no-op、applied、declined 在审计里不可区分，更没有 token/耗时/轮次统计；人只能靠"有没有弹窗"猜有没有沉淀。同时 `agent/disposed` 直接 `shutdown()` 丢弃在途提取——关机会话即丢一次可能已花掉模型成本的提取，且跨会话无差别。基线 §6.4 要求 no-op/skip/update/create 统一回执，§6.7 要求 per-turn 统计，§2.4/§4 要求关闭时有界 drain。

## Decision

- `ReviewRecord.outcome` 新增 `applied` 与 `noop`；`runMemoryExtractionPhase` 全路径记账：检查点无增量与空提案记 `noop`，每 scope 批次记 `applied`（带 refinementId 与本批 applied 数），显式拒绝记 `declined`；每行带 `durationMs`、`memoryTurns`、`memorySearches`（token 本就按 session 进 `token-usage.jsonl` 的 `memory` phase）。失败仍走 scheduler 统一 `failed` 行。
- 前台只唤 applied：`buildMemoryReceipt`/`notifyMemoryExtraction`（`notify.ts`，沿用 followup + 失败收容），仅 turn 路径、有实际落条、且 `notifyOnAutoReview` 开启时排队；no-op 与纯 declined 只留审计行——用户 9-24 已抱怨提取打扰，前台必须吝啬。
- 关闭改有界 drain：`agent/disposed` 对该会话 scheduler 跑 `drainSchedulerOnDispose`（`Promise.race(drain, timeout)` 后 abort，永不 reject、fire-and-forget）；`sessionCloseDrainMs` 进配置（默认 15000，0 恢复旧立即 abort，非法值回默认）。capture 侧本就查 `disposedSessions`，drain 期间不会再接新快照。
- `runGate` 与 scheduler 的 memoryOnly 路径都透传 `record`（此前 memoryOnly 路径压根没传，这是回执缺失的直接根因）。
- 回归：`notify.test.ts`（回执三态文本 + 失败收容）、`auto.test.ts`（drain 默认/0/超时/拒绝四例、no-op 记账行、六处 wiring 期望更新为含 memory 审计行的新序列、dispose 用 50ms 证明有界）。

## Alternatives considered

- **no-op 也弹前台**：每次无事发生的 turn 都唤醒 agent 即用户抱怨的"过于频繁"；审计可查 + 前台吝啬，拒绝。
- **declined 弹前台**：拒绝本就发生在审批弹窗里，人已在场；再弹一次是重复打扰，拒绝。
- **dispose 无限等在途完成**：坏模型调用可挂起数分钟，关闭路径必须有界；15s 是"给一次机会"与"不拖关闭"的折中，0 留给要旧行为的人，拒绝。
- **drain 放在 scheduler.shutdown 内部**：shutdown 语义是"丢弃并 abort"（多处依赖其同步性）；新增独立函数保持旧语义可达，拒绝合入。
- **统计另起新 JSONL**：reviews 行已有 timestamp/session/reason/outcome，加可选字段即满足"按会话查一轮提取花了多少"；新文件增加对账负担，拒绝。

## Consequences

- `reviews.jsonl` 行数约为原来的 2 倍（每轮多一行 memory 行），仍在 500 行预算与修剪路径内；`failures.ts` 只认 `failed`，新 outcome 不影响失败聚合。
- P1 四项至此全部落地；剩余：双语 README 同步、门禁全绿、发版。
