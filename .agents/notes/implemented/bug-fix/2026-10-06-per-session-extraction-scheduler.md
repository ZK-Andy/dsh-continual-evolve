# Agent Note: 提取调度改为按会话隔离（对齐 ZCode 的 per-runtime scheduler）

Status: implemented

## Problem

v0.15.0 的提取调度器是**插件单例**：`pending` 单槽、`running` 单标志、一个全局 10 分钟去抖计时器。但它的游标早已按会话分区（`state` 表的 `seq:<sessionId>`）——**状态归属不一致**：cursor 属于会话，调度状态却属于插件。

2026-10-06 在 dotnet-desktop 真机验收时，提取轨**一次都没跑成**。插桩探针加账本给出两条彼此独立的证据：

1. **跨会话挤占**。任何 agent 的 `agent/turn-stopping` 都执行 `pending = target`（覆盖）并 `clearTimeout` 重置计时器，而 `isInternalAgent` 的过滤排在 `runExtraction` 里（[../../../../src/extraction.ts](../../../../src/extraction.ts)），入口太晚。实测 07:24–08:00 有 10 个子代理（轨迹 header：`origin:"subagent"`、`delegationDepth:1`、`parentSession=session-8843e3d4…`）连续把主会话的边界顶掉并推迟计时器，账本只留下 10 条 `close-drain` / `internal-agent` 墓碑；08:12 进程重启把计时器一并带走。
2. **同会话自我重置**。连续对话时每一轮都重置计时器。探针实测 08:13:53 / 08:16:54 / 08:20:57 / 08:27:10 四次 arm、**零次 fire**——只要人在连续对话，提取永不触发。

ZCode 的做法（工作区缓存 `.zcode-source/extraction.ts` 与 `.zcode-source/project-memory-extraction.ts`）是把 scheduler 挂在 **per-runtime** 上：`runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler(…)`，cursor/pending/running 全在会话自己的闭包里，并且**没有时间去抖**——每轮 `schedule`，运行中就合并进 `latestPending`，空闲则立即跑。

## Decision

调度器改为 **per-session 槽**，去掉时间维度：

- `slots: Map<sessionId, { pending, running }>`；`slotOf` 惰性建槽，`agent/disposed` 时删槽。
- `schedule(agent)` 在**入口即过滤 internal agent**（`isInternalAgent`）：它们不是记忆来源，不占槽、不重置任何会话的边界、也不留账本行；随后写该会话的 `pending` 并 `drain`。
- `drain(sessionId, trigger)`：该会话 `running` 或没有边界即返回；否则取走 `pending`、置 `running`、跑一次 `runExtraction`；`.finally` 中若 `pending` 又非空（运行期间落下的新边界）再 drain 一次——**合并而非排队**。
- **删除 `memoryIndex.debounceMin` 与 `SchedulerOptions`**：不再有计时器，`agent/turn-stopping` 当轮即调度。
- `compaction/start` 与会话关闭只作用于该会话自己的槽；`agent/disposed` 额外删槽。
- `runExtraction` 保留 internal-agent 跳过分支作为纵深防御（其他入口仍记账）。
- 账本 `trigger` 取值不变（`turn-debounce` / `compaction` / `close-drain` 仍在 DDL 的 CHECK 集合内）。`turn-debounce` 现在表示"轮级调度"，这处命名债随表重建一起留到后续版本处理。

## Alternatives considered

- **只把 `isInternalAgent` 提前到入口**：能治子代理挤占，治不了两个真实会话互相挤占，也治不了连续对话自我重置。落败原因：只覆盖三条证据里的一条。
- **保留全局单槽，改为按会话排队**：需要引入"下一个跑谁"的策略与队列。落败原因：复杂度高于"每会话各自 running"，而收益相同。
- **改为轮询驱动**（定时扫会话、比对游标）：完全不依赖 agent 事件。落败原因：把"空闲去抖"换成"轮询间隔"只是换一种延迟；要枚举活跃会话；无增量时空转；ZCode 的既有实现已证明"事件驱动 + 状态隔离"足够。
- **把提取搬到独立进程**：真正"宿主外"。落败原因：轨迹是 zstd+jsonl 私有格式（随 DSH 版本漂移）、凭据与 provider 路由要自行接管、进程生命周期要自己管；插件是 cordis 插件、必然在宿主进程内，而"不受宿主 agent 影响"用状态隔离即可达成。
- **保留 `debounceMin` 但默认改 0**：兼容旧配置。落败原因：留下一个能重现本次故障的开关；v0.15.0 刚发布、无人依赖，且 schemastery 会忽略未知键，删键不破坏现有配置。
- **compaction/关闭时强制中断在飞运行**：边界落地更快。落败原因：中断会丢弃已读入的增量（虽然游标不动，但模型调用已花掉），而"运行完自动 drain 新边界"已覆盖该场景。

## Consequences

- 一个工作区的会话再也无法推迟或顶掉另一个工作区的提取；子代理不参与调度、也不在账本留墓碑。
- 连续对话不再冻结提取："停手 10 分钟"从触发条件里消失，`memoryIndex.extraction` 成为唯一开关。
- 每个会话可各自有一个在飞提取（无全局并发上限）：多会话同时活跃时 LLM 并发峰值上升，但每会话仍严格 single-flight，机械跳过判据照旧记账。
- 调度器测试由 6 例改写扩充为 9 例（无计时器即跑、运行中合并、会话隔离、internal 入口过滤、compaction 不重复、槽清理、dispose 摘监听器），全套 173 例通过；`extraction.ts` 行覆盖 98.88%、分支 86.31%。
- **未发版**（用户拍板）：修复只进 main；dotnet-desktop 上跑的仍是 0.15.0 的全局单槽调度器。
