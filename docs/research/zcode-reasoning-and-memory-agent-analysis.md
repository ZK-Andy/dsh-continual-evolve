# ZCode 推理档位与独立 Memory Agent 方案调研

> 调研日期：2026-09-24。本文记录 ZCode 的模型调用语义、DSH 当时的失败根因，以及两条分层实施建议。
>
> **实施状态（2026-09-24）**：两条建议均已落地。能力感知最低 effort 见 [`src/llm-text.ts`](../../src/llm-text.ts)；专用后台 memory loop、冻结 manifest、闭集 `memory_search` / `memory_propose`、作用域审批与 `EvolutionEngine.apply()` 接线见 [`src/memory-agent.ts`](../../src/memory-agent.ts) 和 [`src/auto.ts`](../../src/auto.ts)。ADR：[`implemented/feature/2026-09-24-dedicated-memory-extraction-agent.md`](../../.agents/notes/implemented/feature/2026-09-24-dedicated-memory-extraction-agent.md)。下文保留实施前问题与取舍证据。
>
> **实现门槛：实现本方案任一代码任务前，必须先完整阅读本文，并以本文的证据、边界和验收条件为准；实现时还需按项目规则补齐 ADR 与回归测试。**

## 1. 结论摘要

当前问题不是自动 review 的 snapshot 或 scheduler 没有工作，而是 DSH 的直属 LLM 调用把 `reasoningEffort` 硬编码为 `off`，触发了当前模型 `opencode-go-deepseek/space-bunny-free` 的能力校验失败。

建议拆成两个相互独立、可分阶段交付的待办：

1. **能力感知的最低推理档位**：先修复 review/planner/wrapup/fate 的直属 LLM 调用；根据精确 provider/model 的 `reasoning.efforts` 选择模型声明的最低可用值，不再硬编码 `off`。
2. **专用后台 Memory Extraction Agent**：在 DSH 已有的增量 snapshot、eligibility、串行 scheduler 之上，增加独立上下文、受限权限、结构化提案和现有 `EvolutionEngine` 应用闭环；这是 ZCode 式记忆提取架构，不是当前 `off` 报错的必要修复。

单独 Agent 运行在后台，不占用主会话的前端交互；它可以有自己的模型上下文、推理档位、工具权限、取消和失败重试语义。

## 2. 证据与现状

### 2.1 ZCode 主会话和辅助调用的推理语义不同

ZCode 的主会话使用会话级的 `thoughtLevel/reasoningLevel`。已读取的运行记录中，模型 `opencode-zen-chat/mimo-v2.5-free` 的会话推理设置为 `enabled`：

- 本地证据：`/home/zk/.zcode/cli/log/zcode-2026-09-19.jsonl`，`session.reasoning_effort.updated` 事件的 `thoughtLevel` 为 `enabled`。
- 该证据只能说明 ZCode 主会话当时的设置，不能直接推断当前 DSH 的 `space-bunny-free` 辅助调用应使用什么档位。

ZCode 内置 provider 配置对 OpenAI Chat Completions 的通用映射是：

```json
{
  "thinking": {
    "type": "enabled"
  },
  "enable_thinking": true,
  "reasoning_effort": "high",
  "reasoning": {
    "effort": "high"
  }
}
```

当 `reasoningLevel` 为 `disabled` 时，映射为关闭思考并将 effort 设为 `none`。当模型的具体规则只提供 `low/high/max` 等档位时，映射直接使用所选档位。

证据来源：

- ZCode 源码摘录：`/mnt/work/work/.zcode-source/`
- 已安装 ZCode provider 配置：`/opt/ZCode/resources/config/provider/zcode-builtin.json`
- ZCode 上游源码：
  - [`project-memory-extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts)
  - [`memory-agent-loop.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts)

### 2.2 ZCode Memory Agent 是独立 loop，但不必是独立模型

ZCode 在主会话成功 turn 后调度 `scheduleProjectMemoryExtraction()`，然后进入独立的后台 memory agent loop：

```text
成功 turn
  → snapshot + cursor
  → eligibility / scheduler
  → Memory Extraction Agent
  → memory manifest
  → 受限读写 memory
  → 成功或 no-op 后推进 cursor
```

已读取的 `memory-agent-loop.ts` 明确使用：

```ts
const request: ModelRequest = {
  messages: mediaProjection.messages,
  options: auxiliaryModelOptions(input.model),
  tools: input.tools as ModelToolContract[],
};
const response = await input.model.generateText(request);
```

这说明：

- Memory Agent 有独立的请求消息上下文和内部 turn 循环；
- 它通常复用传入的主模型对象，而不是天然切换到另一个 provider/model；
- 它通过 `auxiliaryModelOptions(input.model)` 覆盖辅助调用的 reasoning/max-output 选项；
- 它的工具集是专门收窄的，不应把主 Agent 的全部工具暴露给记忆提取器。

已读取的 ZCode memory loop 最多运行 5 个内部 turn。其工具策略允许读取类工具和 memory 目录内的受控写入，拒绝 Agent、MCP、网络及 memory 目录之外的写操作。

### 2.3 DSH 当前不是独立 Memory Agent

DSH 当前的自动 review 路径是：

```text
agent/turn-stopping
  → agent/status(idle)
  → captureTurnSnapshot
  → per-session latest-pending serial scheduler
  → reviewAutoRefine()
  → planWithLlm()（若门禁批准）
  → EvolutionEngine.apply()
```

`auto.ts` 的辅助工作是 fire-and-forget；`turn-snapshot.ts` 已经具备增量事件、内部 Agent 过滤、直接 memory 写入过滤和无用户文本跳过。DSH 当前缺的不是“把主 Agent 复制一份”，而是 ZCode 式的专用提取上下文、manifest、受限工具和结构化提案闭环。

DSH 的 `streamText()` 统一承载 review、planner、wrapup 和 fate 的直属模型调用，但当前实现写死：

```ts
reasoningEffort: ReasoningEffortId("off")
```

实现位置：`src/llm-text.ts`。

### 2.4 DSH 当前失败已被审计记录证实

当前运行目录的 `reviews.jsonl` 已记录多条同类失败：

- session：`session-adefa8c6-0670-45d9-8724-4a03acf99696`
- phase：review
- provider/model：`opencode-go-deepseek/space-bunny-free`
- outcome：`failed`
- 原因：模型不支持 reasoning effort `off`

这证明 snapshot 和 scheduler 已经工作到直属 review LLM 调用；故障点在请求能力不匹配，而不是运行时开关或自动 review 未启动。

## 3. 待办一：能力感知的最低推理档位

### 3.1 目标

让所有 DSH 直属辅助 LLM 调用按精确模型能力选择推理参数，消除对 `off` 的硬编码假设，同时避免无谓使用主会话的 `xhigh`。

### 3.2 推荐规则

在共享 `streamText()` 入口统一处理：

1. 使用 `ctx.llm.resolveModelInfo(provider, model)` 解析精确 provider/model 的能力。
2. 读取 `modelInfo.reasoning?.efforts`。
3. 若存在 effort 列表，优先选择列表中第一个非关闭档（跳过 `disabled`、`off` 或 `none`），即模型声明的最低开启档，例如 `low`；如果模型没有开启档，才回退到第一个关闭档；如果只声明 `xhigh`，则使用 `xhigh`。
4. 如果没有 reasoning 能力元数据，省略 `reasoningEffort`，让适配器/Provider 使用其默认行为；不要凭空发送 `off`。
5. `reviewModel` 覆盖时，针对覆盖后的精确 provider/model 解析能力，不能复用主会话模型的能力。

这不是“始终开启推理”，而是“使用该模型实际支持的最低档”。对于不支持关闭推理的模型，结果会是最低的可用开启档，例如 `low` 或模型唯一支持的档位。

### 3.3 实现边界

- 统一修改 `src/llm-text.ts`，避免 review、planner、wrapup、fate 各自复制一套判断。
- 保留当前 `maxTokens`、prefix-cache、signal、usage observer 和错误审计语义。
- 不在本待办中引入新的 Agent 生命周期，不改变 `/evolve pause|resume|status` 语义。
- 不通过捕获 `off` 失败后盲目重试来掩盖能力错误；应在请求前解析能力，并记录最终采用的 effort，便于诊断。

### 3.4 验收条件

- `space-bunny-free` 不再因 `off` 被拒绝；实际请求使用该模型声明的最低可用 effort。
- 支持 `disabled/off/none` 的模型在同时存在开启档时仍使用最低开启档；只有没有开启档时才关闭辅助调用推理。
- 未暴露 reasoning 能力的模型不会收到臆造的 effort。
- `reviewModel` 覆盖路径按覆盖模型能力选择。
- 失败、abort、max-tokens、usage missing 语义不回归。
- 至少增加能力解析、最低档选择、无元数据省略 effort、reviewModel 覆盖和调用参数快照测试。

## 4. 待办二：专用后台 Memory Extraction Agent

### 4.1 目标

在 DSH 已有的 snapshot/cursor/scheduler 基础上，补齐 ZCode 式专用 Memory Extraction Agent；它消费增量会话证据，但不接管或污染主 Agent 的状态。

### 4.2 推荐架构

```text
成功 turn
  → TurnSnapshot
  → eligibility
  → per-session latest-pending scheduler
  → 独立 Memory Extraction Agent
      - 独立消息上下文
      - 独立辅助模型调用与最低 effort
      - 读取已有 memory manifest
      - 只允许 memory 范围操作
      - 输出结构化 proposal
  → EvolutionEngine.apply(local/project/global)
  → 成功/no-op 后推进 cursor；失败/abort 不推进
```

Agent 的职责是“提出可审计编辑”，最终写入仍经过 DSH 现有 `EvolutionEngine`，保留版本、快照、回滚、审批和审计。不能让后台 Agent 直接绕过治理层写全局状态。

### 4.3 为什么先不直接使用 `ctx.subagents.start()`

当前 benchmark 使用的 `subagents.start()` 请求契约没有暴露每次子 Agent 独立的 provider、model、reasoning effort 和 memory-only 工具边界。直接复用它会导致：

- 可能继承主 Agent 的 `xhigh`，无法执行最低辅助 effort；
- 无法表达 ZCode 的受限 memory 工具集；
- 把架构差异隐藏在通用子 Agent API 后面，后续难以审计和测试。

优先方案是插件内部实现专用 extraction loop；如果未来扩展宿主 `subagents` 契约以支持 per-run model/effort/tool policy，再评估迁移到通用子 Agent 服务。

### 4.4 Agent 权限边界

允许：

- 读取已有 memory manifest 和必要条目；
- 在 memory store 允许范围内读取、更新、创建、归档或删除候选；
- 生成结构化 proposal。

禁止：

- 调用主 Agent、通用子 Agent、MCP 或网络；
- 修改项目源码和非 memory 文件；
- 把自己的中间轨迹写回主会话；
- 绕过 `EvolutionEngine`、作用域审批和审计。

前端不应等待该 Agent。后台 scheduler 应支持：

- 每会话串行；
- 突发 snapshot 只保留最新 pending；
- shutdown/dispose abort；
- 有界 drain 或明确的后台生命周期；
- 失败不推进 cursor，后续 snapshot 可重试。

### 4.5 验收条件

- 成功 turn 的增量 snapshot 能进入独立 extractor；无用户文本、内部 Agent、直接 memory 写入等机械噪声被跳过。
- 已有 manifest 可见，update-first 规则可被测试。
- extractor 不能修改 memory 之外的路径，也不能调用外部 Agent/MCP/网络。
- extractor 失败或 abort 不推进 cursor；后续 snapshot 能重试。
- proposal 经 `EvolutionEngine.apply()` 写入，保留版本、回滚、审批和审计。
- 辅助模型调用使用待办一的 capability-derived lowest effort；不因主会话 `xhigh` 强制继承。
- 多个并发 session 互不串 cursor，后台运行不阻塞主 Agent 或前端。

## 5. 不采用的方案

### 5.1 固定改成 `low`

不能采用。不同 provider/model 的合法 effort id 不统一，有些模型不支持 `low`，有些只支持 `enabled`、`high` 或 `xhigh`。固定值仍会造成能力错误。

### 5.2 保留 `off`，失败后重试

不能采用。当前错误在 provider 调用前的能力校验阶段就会失败；重试只会制造重复审计和成本，且无法解决契约不匹配。

### 5.3 直接继承主 Agent 的 `xhigh`

不采用为辅助调用的默认方案。它可能提高质量和预算，但会让 review/planner/fate 付出不必要成本；ZCode 的辅助模型选项也表明辅助调用与主会话选择分离。

### 5.4 直接套用通用 `ctx.subagents.start()`

暂不采用。当前 API 缺少本方案需要的 per-run model/effort/tool policy，强行套用会把关键治理边界藏起来。

### 5.5 只修 `off`，不建设独立 extractor

可以作为第一阶段交付，但不能宣称已经完成 ZCode 式 Memory Agent。两条待办必须保持独立状态：前者解决当前请求失败，后者解决提取上下文、权限和闭环缺口。

## 6. 实施顺序与阅读要求

1. 先实现待办一，交付 capability-derived lowest reasoning effort，并回归验证当前 `reviews.jsonl` 失败是否消失。
2. 待办一稳定后，再实现待办二的专用 Memory Extraction Agent；不要把两条变更混成一个不可审查的大补丁。
3. 任何实现任务开始前，必须先阅读本文的证据、边界和验收条件；如果实现决策改变本文结论，应先更新本文，再更新 ADR 和代码。

## 7. 参考

- ZCode Memory 对标总览：[`docs/research/zcode-memory-parity-analysis.md`](zcode-memory-parity-analysis.md)
- DSH 自动 review：[`src/auto.ts`](../../src/auto.ts)
- DSH snapshot：[`src/turn-snapshot.ts`](../../src/turn-snapshot.ts)
- DSH 共享 LLM 调用：[`src/llm-text.ts`](../../src/llm-text.ts)
- DSH 模型能力类型：`@deepseek-ai/dsh-llm` 的 `LlmModelInfo.reasoning.efforts`、`resolveModelInfo()` 和 `resolveCallConfig()`。
- ZCode 上游：[`zai-org/ZCode`](https://github.com/zai-org/ZCode)
