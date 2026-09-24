# Agent Note: 记忆 Agent 默认接线与通用管线断开

Status: implemented

## Problem

通用 review/planner、local fate 以及自动 prompt/skill 进化会在成功回合后持续触发，造成不必要的模型调用和自动落地风险；需要一条默认边界：自动运行只限专用 Memory Agent，通用管线必须显式手动调用。

这条边界一度被收紧过头：把 `autoReview` 同时当作**注册门**（`autoReview === true` 才注册 listener）后，默认安装（profile 无配置）既不注册 listener，`/evolve resume` 也被静态策略拒绝，用户必须手改 `cordis.patch.yml` 才能开启。这与「运行时开关替代静态配置启停」的既定决定相矛盾，也让装完即用失效——v0.7.5 实机在 dotnet-desktop profile 上复现：升级后 `plugin.log` 只剩 `wiring disabled`，两次 `/evolve resume` 均被拒。

## Decision

- `src/index.ts` **始终注册**专用 Memory Agent listener；`autoReview` 只提供没有 `evolve/runtime.json` 时的**初始默认**，不是注册门。运行时开关（v2 `{enabled, paused}`，由 `/evolve pause|resume` 写入）是唯一有效控制面。
- 该 listener 以 `memoryOnly` 模式只进入 `runMemoryExtractionPhase`：通用 review/planner、prompt/skill 写入与 local fate 都不可达（`runGate` 是后三者的唯一自动入口，memory-only 下不会被调用；`session/event` 的 compaction 路径同样机械返回）。`localFate` 保持默认 `false`。
- Memory eligibility 对齐 ZCode：空增量、内部 Agent、直接 memory 写入、synthetic/model-only 文本机械跳过；直接用户文本按单个 text part 计算，至少 `memoryMinUserWords` 个词（默认 3，使用 `Intl.Segmenter` 做 CJK-aware 分词），不把多个短消息拼接后放宽门槛。
- `/evolve status` 报告初始默认与运行时态；`/evolve pause`、`/evolve resume` 控制或说明 Memory Agent runtime，不声称控制通用 review/planner。手动 `evolve_*` 工具、`/evolve` 人工命令、benchmark 和存储能力保持可用。

## Alternatives considered

- **注册门用 `autoReview === true`（上一版形态）**：落败。默认安装没有 profile 配置时不注册 listener，`/evolve resume` 被静态策略拒绝，必须改文件才能开启；既违背「运行时开关替代静态启停」，也违背装完即用。回归由 `test/command.test.ts` 的 `autoReview: false` resume 用例钉死。
- **把 `autoReview: true` 写进插件 bundle `cordis.patch.yml`，让安装带上配置**：落败。profile 层覆盖优先级更高，策略随用户配置漂移；默认只能是代码里的事实，靠 profile 表达默认已在上一条否决。
- **拆成 `genericReview` 与 `memoryAgent` 两个开关**：落败。通用管线本就不可达，多一个开关只增加状态组合与文档面，没有新增能力。
- **只写本机 `evolve/runtime.json`**：属于环境状态，不是项目代码的默认策略，无法防止其他 profile 或安装重新启用。
- **删除自动进化模块**：超出本轮范围，会丢失独立 Memory Agent 的演进路径。

## Consequences

默认安装即注册 listener，`/evolve resume` 可即时开启 Memory Agent，无需编辑 profile；`autoReview: true` 只改变没有 `runtime.json` 时的初始态。通用 review/planner、prompt/skill 写入与 local-fate 自动运行仍不可达，只能显式手动调用。代价：`CommandRuntimeOptions.memoryOnly` 随「恒为 memory-only」一并移除，选项面少一个自由度。

## Testing

- `test/command.test.ts`：`autoReview: false` 下 `/evolve resume` 成功，`status` 报告 `Memory Agent running` 与 `config default off`（v0.7.5 回归钉死）；pause/resume 幂等与 status 各态文案沿用原有用例。
- `test/index.test.ts` 随 `automaticEvolutionWired()` 一并删除——该文件唯一的测试对象就是那个注册门判断。
- 全量：`tsc` 零错、`oxlint` 零警告、44 文件 742 测试全绿。
