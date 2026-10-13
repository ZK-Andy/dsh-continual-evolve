# Agent Note: 直属 LLM 调用的路由与推理档位

Status: implemented

## Problem

提取轨与评审环的直属 LLM 调用（`ctx.llm.stream`）在生产中整片失败，账本只剩一句 `stream finished with error`：同一时段里某个会话的调用 100% 失败、别的会话 100% 成功，而它们的 provider/model 完全相同（`dsh-opencode-go` / `deepseek-v4.1-flash`）。四个叠加的缺陷：

1. **路由取自 `agent.options`，而它不是当前路由。** 宿主把"默认模型"放在 `agentDefaultModel` 服务里（`ctx.get("agentDefaultModel").currentSelection()`），`agent.options` 只承载**显式选择**——用默认模型的会话在那里什么都没有。宿主的官方消费方（会话控制器、无头入口）都从该服务取；宿主 Agent 自己遇到空路由时直接抛 `has no provider/model`。
2. **推理档位没有随调用发出。** [能力推导档位](2026-09-24-capability-derived-reasoning-effort.md)给当时的共享边界 `llm-text.ts` 定了"按精确 provider/model 解析最低开启档"的纪律；`dc1e679`（对齐 ZCode 的折叠重构）删掉该边界后，取而代之的 `streamOnce` 没有恢复它，请求里从不带 `reasoningEffort`。
3. **失败原文被吞。** `finish` 只取 `reason.kind`，`reason.failure` 的 code/message 全丢——真因因此一整天不可见。
4. **生命周期两处漏。** 两个调度器的 disposer 在组装根被丢弃，重挂载（HMR / 改配置）会留下第二个调度器、握着已被替换的 LLM 服务；评审的 `lastRoute` 是全局单槽，且 `agent/disposed` 会拿刚销毁的会话身份发起调用。

## Decision

新建 `src/llm-call.ts` 作为两条轨共用的直属调用边界，三条纪律各归一处：

- **路由**：`resolveCallRoute(agent, get)` 先取 `agent.options` 的显式选择，再取宿主 `agentDefaultModel` 服务（经 `ctx.get` 读，不入 inject 列表）。两者皆无则**拒绝发送**：提取记 `no-route` 跳过，评审记 `no-route` 跳过。组装根把 `resolveRoute` 注入两个调度器；缺省回退到只读 `agent.options`（旧宿主与测试）。
- **档位**：`streamOnce` 调 `llm.resolveModelInfo(provider, model)`，用 `selectLowestReasoningEffort` 取最低**开启**档；无能力查询或无元数据则省略该字段；能力查询抛错在 provider I/O 之前暴露，不重试。不继承主会话的显式档位。
- **失败原文**：`error` / `aborted` 终止一律抛出，文案带宿主 `failure` 的 `code: message`；`max-tokens` 仍交给调用方裁决（门在预算切断前可能已给出完整 verdict）。
- **生命周期**：调度器 disposer 挂到所属 fiber 的 `effect`；评审只在 turn-stopping 拿到活路由时更新 `lastRoute` 并 drain，`compaction/start` 与 `agent/disposed` 不再主动调用。

## Alternatives considered

- **只补 failure 原文，不改路由**：能拿到真因，但用默认模型的会话永远没有路由——提取轨每次记 `no-route`、评审环完全不工作，等于把"静默失败"换成"静默不工作"。
- **插件自己读 profile patch 拿默认模型**：跨进程读配置是第二真相源，profile 一改就漂移；宿主已把该选择暴露成服务，读服务是唯一正解。
- **无路由时退回主会话的 provider/model**：拿不到就是拿不到；用别的会话的身份调用，正是 `agent/disposed` 那条失败路径的成因。
- **继承主会话的 `reasoningEffort`**：辅助调用会按主会话档位计费，且主会话档位与精确模型能力未必匹配——[能力推导档位](2026-09-24-capability-derived-reasoning-effort.md)已否决过一次。
- **恢复整个 `llm-text.ts`（含 BlockAssembler 与工具循环）**：折叠重构删它是为了极简，现在需要的只是路由/档位/失败文本三条纪律，恢复整块会重新引入没人用的抽象。

## Consequences

- 用默认模型的会话第一次真正能跑提取与评审；显式选择的会话行为不变。
- 每次直属调用多一次能力解析（宿主 `resolveModelInfo`）；无元数据时请求形状与从前一致。
- 评审不再有"会话关闭即评完"的补评点：待评工作区留到下一个 turn 边界（带活会话身份）再评，延迟上限是一次会话活动。
- 提取的失败行不再缺 `model` 列，失败原文带宿主 code/message。
- 全量测试 362 / 26 文件；typecheck、lint 与文档门禁全绿。
