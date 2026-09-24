# Agent Note: 默认断开自动进化接线

Status: implemented

## Problem

通用 review/planner、local fate 以及自动 prompt/skill 进化会在成功回合后持续触发，造成不必要的模型调用和自动落地风险。仅修改本机 runtime 或 profile 配置不能表达项目代码的默认边界，且 `/evolve resume` 可能重新打开自动管线。

## Decision

`autoReview` 变为专用 Memory Agent 自动接线的显式开关：只有严格为 `true` 时，`src/index.ts` 才注册 `registerAutoReview` 的回合/压缩监听器；该 listener 以 `memoryOnly` 模式只进入 `runMemoryExtractionPhase`，不会调用通用 review/planner、prompt/skill 写入或 local fate。默认 `false` 时完全不注册自动 listener。`localFate` 保持默认 `false`。

`/evolve status` 真实报告 Memory Agent listener 是否接线；`/evolve pause`、`/evolve resume` 控制或说明 Memory Agent runtime，不声称控制通用 review/planner。手动 `evolve_*` 工具、`/evolve` 人工命令、benchmark 和存储能力保持可用。

## Alternatives considered

- 只把 `autoReview` 默认值改成 false：不足以阻止已有 runtime/profile 显式值重新启用 listener。
- 只写本机 `evolve/runtime.json`：属于环境状态，不是项目代码的默认策略，无法防止其他 profile 或安装重新启用。
- 删除自动进化模块：超出本次“保持暂停”的范围，会丢失未来显式恢复和独立 Memory Agent 演进路径。

## Consequences

默认安装不会产生自动回合 snapshot 或 Memory Agent 调用；`autoReview: true` 只启用专用 Memory Agent，不会产生通用 review/planner、prompt/skill 或 local-fate 自动写入。通用路径仍可通过显式手动命令运行。运行时开关保留给已接线的 Memory Agent listener。
