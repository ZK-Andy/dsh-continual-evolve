# Agent Note: 按模型能力选择最低推理档位

Status: implemented

## Problem

`streamText()` 统一承载 review、planner、wrapup 与 fate 的直属 LLM 调用，但当前把 `reasoningEffort` 固定为 `off`。支持关闭推理的模型可以工作，不支持该档位的精确 provider/model 会在请求前被能力校验拒绝，例如 `opencode-go-deepseek/space-bunny-free`。不同模型的合法 effort 标识不统一，不能用固定 `low` 或继承主会话的 `xhigh` 代替能力解析。

## Decision

- `streamText()` 在共享入口按精确 provider/model feature-detect `ctx.llm.resolveModelInfo()`，从 `modelInfo.reasoning.efforts` 选择模型声明的最低开启档：跳过关闭档 `disabled`/`off`/`none`，使用适配器公布的第一个开启 effort；只有完全没有开启档时才回退到第一个关闭档。
- 没有 reasoning 元数据或旧宿主没有能力查询方法时省略 `reasoningEffort`，让 provider 使用自身默认；不捕获能力错误后重试，也不改变主 Agent 的推理设置。
- 保持 maxTokens、prefix-cache、abort、usage observer、失败审计和 reviewModel 覆盖路径不变；`StreamTextObservation` 额外携带最终采用的 effort 供诊断。
- 回归测试覆盖能力解析、最低档/关闭档、无元数据省略、resolver 失败不重试、调用参数和 reviewModel 覆盖；设计、FAQ 与双语 README 同步。

## Alternatives considered

- **固定改成 `low`**：不同 provider/model 的合法 effort id 不统一，仍会造成能力错误。
- **保留 `off` 并在失败后重试**：能力校验在 provider I/O 前失败，重试只会制造重复审计与成本。
- **继承主 Agent 的 `xhigh`**：辅助调用质量收益不确定，却会无谓消耗主模型预算。
- **在各 phase 复制判断**：容易让 reviewModel 覆盖和无元数据路径漂移；共享入口是唯一能力咽喉。

## Consequences

- review、planner、wrapup、fate 共享同一能力选择语义；reviewModel 覆盖按覆盖后的路由解析，不会复用主会话模型能力。
- 旧宿主或测试 fake 没有 `resolveModelInfo` 时保持原请求形状，只省略新增 effort 字段；能力解析错误在 provider 流开始前暴露，observer 仍收到 `outcome: "error"`。
- 现有 finish、abort、max-tokens、usage、prefix-cache 与审计语义保持不变；全量测试为 685 tests / 43 files，typecheck 与 oxlint 通过。
- 每次直属调用增加一次精确模型能力解析；若后续需要消除 HMR 期间能力与 dispatch 的代际竞态，再单独评估 DSH `prepareCall` 绑定方案。

---
