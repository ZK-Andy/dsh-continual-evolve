# Agent Note: 插件直属 LLM 精确 token 账本

Status: implemented

## Problem

- `/evolve usage` 只统计条目进入多少次会话提示，无法回答自动 review、planner、wrapup/fate 自身消耗了多少模型 token。
- DSH `dsh-llm` 已在流中返回 provider-reported `TokenUsage`，插件的统一 `streamText` 也使用 `BlockAssembler`，但此前只读取文本与 finish，丢掉了 usage。
- #21 的只读 Markdown 镜像与 Web 设置页不再推进；本轮只补 token 账本。

## Decision

- `streamText` 在 `finally` 中恰好观察一次最终 usage/result，覆盖 success、provider error、abort、max-tokens、empty 与流迭代异常；观察回调抛错不会改变模型调用结果。
- 新增版本化 `evolve/token-usage.jsonl`，逐行记录插件直属 review / planner / wrapup / fate 调用：时间、会话、phase、provider/model、outcome、usage 状态、total 来源，以及 provider 报告的 uncached input、cache read/write、output、reasoning、total。缺失 usage 明确记为 `missing`，不伪装成零。
- `dsh-llm@0.1.0-rc.6` 与 `0.1.5-rc.3` 均有 `BlockAssembler.usage`；旧契约没有 `totalTokens` 时由四个互斥输入桶与 output 求和，reasoning 不重复累加。
- JSONL 新文件以 0600 创建；append 与条件裁剪处于同一同步块，避免单 DSH 进程内异步调用交错。多 DSH 进程共享同一 baseDir 不属于存储契约。
- `historyRetain.tokenUsage` 独立控制尾部预算，默认 500；不与 `reviews` 复用。
- `/evolve usage` 在条目注入账本后追加直属调用汇总：报告 reported/missing 覆盖、五类 token 桶、phase 分布、最近调用、保留窗口与损坏行数量，并明确 Benchmark executor/reviewer 宿主子代理、其 agent-loop 调用和逐条 memory 注入成本不在本账本。
- Benchmark 子代理拥有独立 session 日志，但其 executor/reviewer 归属、失败和内部多轮调用需要单独设计；本轮明确排除，不用不完整数据冒充“插件总成本”。

## Alternatives considered

- **只按字符数估算 token**：落败。不能反映 provider 分词、缓存读写和模型输出，且 CJK/JSON schema 误差大；provider 已返回真实 usage，无需降级。
- **复用 session token-meter 投影**：落败。review/planner/wrapup 是一次性 `ctx.llm.stream`，没有 sessionId，不进入调用方会话日志。
- **把调用账本写进 `usage.json`**：落败。`usage.json` 是条目注入计数，调用频率、并发模型和写盘方式不同；独立 JSONL 职责更清楚。
- **第一版汇总 Benchmark 子代理**：落败。需要跨子代理 session 生命周期、executor/reviewer 双路归属和失败重试计费，无法用少量代码可靠证明。
- **把每条 memory 的目录行当作精确计费**：落败。provider 只报告整个请求的 token，无法从总输入中精确拆分某条注入内容。

## Consequences

- 用户可在 `/evolve usage` 看到插件直属 LLM 调用的真实 provider token 账本，并能区分“调用发生”与“provider 确实返回 usage”。
- 统计是受 `historyRetain.tokenUsage` 限制的滚动窗口，不是永久账单。
- 报告不声称覆盖 Benchmark 子代理或主会话，也不声称能逐条归因注入 token。

## Testing

- `streamText` 成功、error、aborted、max-tokens、empty、流异常与缺失 usage 的 exactly-once settlement，以及回调隔离。
- token 账本 append/load、损坏/未知版本跳过、0600、旧版 total 求和回退、并发 settlement、独立 retention 与报告覆盖。
- 自动 review + planner、自动 fate、手动 plan、手动 wrapup 的接线，以及 `/evolve usage` 的 Benchmark 排除文案。
- 41 个测试文件、665 个测试全绿；TypeScript 与 oxlint 零错误。
