# Agent Note: 默认断开自动进化接线

Status: implemented

## Problem

通用 review/planner、local fate 以及自动 prompt/skill 进化会在成功回合后持续触发，造成不必要的模型调用和自动落地风险。仅修改本机 runtime 或 profile 配置不能表达项目代码的默认边界，且 `/evolve resume` 可能重新打开自动管线。

## Decision

`autoReview` 变为自动进线的显式开关：只有严格为 `true` 时，`src/index.ts` 才注册 `registerAutoReview` 的回合/压缩监听器；默认 `false` 时完全不注册自动 memory/review/planner/fate 接线。`localFate` 默认改为 `false`，即使显式打开通用自动管线，也必须单独 opt-in 才会运行。

`/evolve status` 真实报告 listener 未接线；`/evolve pause`、`/evolve resume` 在项目策略关闭时返回说明，不声称已控制不存在的 listener。手动 `evolve_*` 工具、`/evolve` 人工命令、benchmark 和存储能力保持可用。

## Alternatives considered

- 只把 `autoReview` 默认值改成 false：不足以阻止已有 runtime/profile 显式值重新启用 listener。
- 只写本机 `evolve/runtime.json`：属于环境状态，不是项目代码的默认策略，无法防止其他 profile 或安装重新启用。
- 删除自动进化模块：超出本次“保持暂停”的范围，会丢失未来显式恢复和独立 Memory Agent 演进路径。

## Consequences

默认安装不会产生自动回合 snapshot、自动 LLM 调用、自动 fate 或 prompt/skill 写入；需要自动管线时必须在项目配置中显式设置 `autoReview: true`，并按需设置 `localFate: true`。运行时开关仍保留给显式接线的构建。
