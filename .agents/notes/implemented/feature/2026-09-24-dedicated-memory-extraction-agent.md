# Agent Note: 专用后台记忆提取 Agent

Status: implemented

## Problem

DSH 已有 ZCode 风格的增量 snapshot、eligibility、每会话串行 scheduler、cursor 和失败重试，但通用 review/planner 同时处理 prompt、memory、skill、subagent，无法为 memory 建立独立上下文、受限工具和独立失败边界。直接把文件型 Memory Agent 搬过来又会绕过 DSH 的 JSON 单一事实源、作用域审批、版本、快照、回滚和审计。

## Decision

- `src/memory-agent.ts` 实现插件内部专用 loop，最多五个内部 turn。它有自己的消息上下文和冻结的 memory manifest，只向 provider 注册 `memory_search` 与 `memory_propose` 两个工具；未知工具名被拒绝，Agent 没有 Agent/MCP/网络/源码/文件写入路径。
- `memory_propose` 只接受 `kind=memory`、显式 target scope、受限的 `metadata.memoryType` 和最多 20 条编辑。update/archive/delete 必须命中同 scope manifest；create id 使用控制字符安全的 identifier grammar。update 时模型 metadata 与已有 provenance、archive、conflict 等 engine-owned metadata 合并，模型不能伪造或擦除这些字段。
- 共享 `streamModelTurn` 按精确 provider/model 能力选择最低 reasoning effort，并支持文本/工具请求的统一 finish、abort、usage 观察。纯文本调用要求 text block；memory turn 要求 text 或 tool-call，reasoning-only 不会伪记成功。
- `runMemoryExtractionPhase` 在通用 review/fate 前运行。它使用 session-specific memory checkpoint：memory 成功、no-op 或显式拒绝后推进；后续 review/fate 失败不会重放旧 memory 决策。共享 scheduler 的 capture 按 session 串行，pending acquisition 按最高已结算 seq/index boundary 合并，迟到旧边界不会回退 cursor。
- project/global 写入先完成全部持久化审批，再按 scope 进入 `EvolutionEngine.apply()`。审批只接受唯一明确的批准/拒绝，弹窗列出每个 action/scope/id（JSON 转义）、title、path、content preview、memoryType 和相似冲突提示；缺失/重复/未知/畸形回答、审批服务异常和 abort 都保留 memory checkpoint。显式拒绝是 scope no-op。
- memory apply 在每次写前检查 abort；per-edit failure、engine 后续 scope 异常或 history/post-commit hook 失败时，用携带 refinement result 的 `EvolutionApplyPostCommitError` 和 `engine.rollback()` 补偿本批次已写 scope。project/global 与 global 同样经过 secret、id、path、content、structured metadata 筛查。
- 通用 auto-review planner 的 memory 编辑被机械剥离，memory-only 计划不伪装成 skill-consent 失败。memory token 账本使用独立 `memory` phase；成功 apply 写 `evolve_complete` 审计，后台不发送主会话 follow-up。
- 回归覆盖工具 loop（搜索、propose、fallback、畸形参数、多工具、超时、abort）、manifest/update-first、metadata 生命周期、审批完整性与补偿、project secret、cursor/checkpoint、乱序 acquisition、多 session/dispose、通用 planner memory-only 兼容和 token ledger。

## Alternatives considered

- **直接使用 `ctx.subagents.start()`**：当前契约不能为每次运行声明独立 model、effort 和 tool policy，可能继承主 Agent 的高预算，也无法机械证明 memory-only 权限，拒绝。
- **继续让通用 planner 顺便提取 memory**：上下文、工具和失败边界混杂，无法形成独立提取责任，拒绝。
- **照搬 ZCode 的 Markdown 写入**：会形成双事实源，绕过作用域审批、版本、快照、回滚和审计，拒绝。
- **让后台 Agent 直接调用全部 `evolve_*` 工具**：注册面过宽，权限闭集无法证明，拒绝。
- **把 malformed approval 当作拒绝**：会推进 cursor 并永久丢失用户未明确拒绝的提案，拒绝。
- **直接写 memory state 或用单一共享 cursor 重试所有 phase**：会绕过引擎治理或重复询问/重复应用，拒绝。

## Consequences

- eligible 成功回合会增加 memory 辅助模型调用；每个 turn 默认沿用门禁输出预算，最多五个 turn，可用 `reviewModel`、`/evolve pause` 和 `/evolve usage` 控制与观察。
- memory/project/global 仍由 JSON engine 统一持久化；Markdown 投影、定向 recall、memory 专用 benchmark 和统一前台回执仍是后续工作。
- 当前测试基线为 44 个测试文件、全部回归通过；typecheck、oxlint、coverage 和文档治理门禁是交付前必检项。
