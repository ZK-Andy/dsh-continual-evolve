# Agent Note: 0.1.7-alpha.1 三处宿主契约漂移的对账

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

把 devDependencies 升到宿主正在跑的 0.1.7-alpha.1 后，编译期与运行期同时暴露三处契约漂移，其中一处的失败模式是静默的：

- **消息来源 kind 收窄**：宿主把 `MessageSourceMap` 改成 merge-extensible 求和类型，每个生产者声明自己的 `kind`，删除了共享的 `kind: "plugin"`。本插件三处注入点（自动门禁通知、本地命运通知、内部 LLM 调用）仍写旧 kind。失败模式：类型编译失败。
- **会话日志读取接口移除**：`Session.events` getter 不复存在，取而代之的是 `snapshotEvents()` / `ownEvents()` / `eventAt()`，三者均已标记 deprecated（上游 Agent Note 禁止新增同步读取）。本插件在 `inject.ts` 与 `source.ts` 里按 duck typing 读 `agent.session.events`——字段消失时不报错，只是拿到 `undefined`。失败模式：**静默**。相关性查询空转（注入排序退回纯 recency），轨迹引用退化为只有 sessionId、丢掉 seqs。类型系统管不到 duck-typed 读取，因此这是三处里唯一会在真实会话里无声降级的一处。
- **工具执行上下文类型收紧**：`defineTool` 的 `exec` 现在是宿主导出的 `ToolRunContext`。本插件为省一个 import 手写的结构类型 `ToolExec`（`{ agent?: { id; session?: { events? } } }`）与之不再兼容：真实 `Agent.session` 与那个全可选的结构体没有公共属性，`exactOptionalPropertyTypes` 下直接报错。

## Decision

- **消息来源**：新增 `src/message-source.ts`，在其中做一次 `declare module "@deepseek-ai/dsh-llm"` 的 `MessageSourceMap` 合并，声明本插件自己的 `kind: "continual-evolve"`，并导出唯一的来源常量 `EVOLVE_MESSAGE_SOURCE`；三处注入点共用该常量，不再各写一遍字面量。`test/notify.test.ts` 的断言同步到新 kind。
- **会话日志**：`AgentLike.session` 增加 `snapshotEvents?: () => readonly unknown[]`，并新增唯一读取入口 `sessionEventsOf(agent)`——优先取 `events` getter（0.1.0 至 0.1.6），缺失时回落到 `snapshotEvents()`（0.1.7 起），两者都没有时返回 `[]`，让每个调用方走自己的空日志分支而不是抛错。`inject.ts` 与 `source.ts` 改为调用它。回归测试覆盖"只有 `snapshotEvents`"与"两个读取器都没有"两种会话形状。
- **工具上下文**：删除手写的 `ToolExec`，直接使用 `@deepseek-ai/dsh-tools` 导出的 `ToolRunContext`；`applyEditsText` 的 `agent` 参数取 `ToolRunContext["agent"]`。

## Alternatives considered

- **只改 kind 字符串，保留手写的执行上下文结构类型**：`ToolRunContext` 已经是宿主导出物，手写副本只会随宿主再次漂移（本次即是）。落败。
- **会话日志改为订阅 `ctx.on("session/event")` 并自维护缓冲**：这是上游 Agent Note 指出的方向（禁止新增同步读取），但需要每会话缓冲、生命周期与顺序保证，属独立改造。本次以仍可用的 `snapshotEvents()` 恢复行为，订阅方案见 Deferred。落败于本变更范围。
- **改用 `ownEvents()`**：其语义是 fork 继承前缀之后的本会话事件，与旧 `events` getter 的全量语义不同，会丢掉 fork 继承的历史。落败。
- **保留 `kind: "plugin"`（运行期不校验，照样能跑）**：宿主消费者只对已知 kind 特判，未知 kind 一律当不透明内容，等于放弃来源归因。落败。
- **在 `sessionEventsOf` 里让 `snapshotEvents` 优先**：旧世代两个读取器并存时，`events` 返回的是宿主缓存的快照，语义与行为都等价于现状，换读取器没有收益。落败。

## Consequences

收益：三处漂移都有编译期或回归测试兜底；会话日志读取收敛为单一入口，同时兼容两代宿主，静默降级不再可能（两个读取器都没有时才返回空）。

代价：`snapshotEvents()` 在上游已 deprecated 且被列为"新调用禁止"，本读取是迁移期继续可用的选择；上游移除它时必须改走事件订阅，否则会话读取会再次静默失效。`sessionEventsOf` 的 `snapshotEvents` 只按零参调用声明（全量日志），因此它不覆盖宿主的区间读取能力——本插件也不需要。

## Deferred

- 用 `session/event` 订阅 + 每会话环形缓冲替代同步读取，彻底摘掉 deprecated 依赖（上游视角的正确解，属独立改造）。

## Related

- 依赖契约与版本策略：[2026-09-22-host-provided-peer-dependencies.md](../process/2026-09-22-host-provided-peer-dependencies.md)。
- 上游拆除依据：dsh-session 类型注释引用的 Agent Note `2026-09-09-deprecate-synchronous-session-event-reads`。
