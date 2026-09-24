# Agent Note: ZCode 成功回合快照与串行调度

Status: implemented

## Problem

旧的自动 review 由固定 `reviewIntervalTurns` 决定是否在 idle 时运行；`autoReview` 静态配置还同时决定监听器是否注册。这样默认关闭时 `/evolve resume` 无法即时开启，运行中的回合只能丢弃触发，整段 surface 也会在每次 review 中重复读取。并发触发只有 `GateState.running` 防重入，没有 latest-pending、cursor、失败重试或 session 关闭时的 abort 语义。

## Decision

- `registerAutoReview` 始终注册 DSH turn/status/compaction 监听器；`autoReview` 只决定没有 `evolve/runtime.json` 时的初始默认状态。runtime 文件升级为 v2 的 `enabled` + `paused`，`/evolve resume` 显式写入 enabled=true，`/evolve pause` 保留 enable 位并阻止新快照。
- DSH 的 `agent/turn-stopping` 只记录成功回合边界；后续 `agent/status=idle` 捕获当前有效 surface。捕获结果按 seq cursor（无 seq 时按事件数）取增量行。
- 快照先做机械 eligibility：空增量、内部 agent、直接 evolve memory mutation、synthetic/model-only/过短用户文本均记录 `skipped`，不调用模型。review 与 planner 的 prefix-cache Route A 也只接收该快照的增量行。
- 每个 session 使用一个 `createReviewScheduler`：运行期间只保留最新 pending snapshot；success/no-op 才推进 cursor，error/abort 不推进；`agent/disposed` 调用 shutdown。通用 review/planner、local/project/global 引擎写入、审批、快照、审计和回滚保持原路径。
- `reviewIntervalTurns` 保留为 local-fate 的兼容节奏配置，不再是普通 review 的触发门槛；新增 `turn_snapshot` 审计 reason，旧的 `turn_interval` 类型保留给历史调用兼容。

## Alternatives considered

- 只把固定轮数从 6 改成 1：保留了整段历史重读、触发丢失和并发重入，不能实现增量 cursor 或失败重试，拒绝。
- 继续用静态 `autoReview` 决定是否注册监听器：会让默认关闭安装无法通过 `/evolve resume` 开启，拒绝。
- 直接把 pending 快照全部排队：长 review 会造成无界队列和过时上下文，采用 ZCode 的 latest-pending 合并。
- 把通用 review/planner 拆成文件型 Memory Agent 或直接写 Markdown：超出本次运行时调度范围，也会削弱 DSH 的版本化、审批、回滚和单一 JSON 事实源，保留为后续独立设计。

## Consequences

- 成功 turn 的自动 review 成本从“每 N 轮”变为“每个有 eligible 增量文本的成功 turn”，无用户文本的噪声 turn 仍可机械跳过。
- `runtime.json` 旧 v1 `{paused}` 文件可读；新写入使用 v2。损坏文件按配置默认启用与否 fail-safe，不阻断主会话。
- compaction 仍可强制捕获快照；暂停时不捕获、不执行 pending，运行中任务收到 abort signal。
- DSH 仍以 JSON harness state 为事实源；ZCode 的文件记忆投影和专用文件 Memory Agent 尚未并入本轮。
