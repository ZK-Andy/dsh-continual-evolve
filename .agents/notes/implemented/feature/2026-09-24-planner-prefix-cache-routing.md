# Agent Note: Planner prefix-cache 感知路由

Status: implemented

## Problem

规划器（`planWithLlm`）与门禁（`reviewAutoRefine`）每次调用都把会话轨迹压成扁平文本随请求重发：门禁每 6 turn 重发 up to 40k 字符的 `<conversation>` 块，规划器重发 400 字符的 `<session_trajectory>` 块。在支持 prompt caching 的 provider 上，这些与会话重复的 token 本可按缓存价结算；且扁平文本丢失了 user/assistant 角色结构，门禁判断"谁说了什么"时只能靠 `role:` 前缀文本。灵感来源是 `dsh-continual-harness` 的 Route A/B 设计（`research/dsh-continual-harness`，已做代码级比对，非复刻），按本地 0.1.7 seam 做了适配。

## Decision

新增 `src/prefix-cache.ts`，三个纯函数 + 一个配置类型：`hasCacheEvidence` 扫描会话事件里 `assistant/message` 的 `data.usage.cacheReadTokens > 0`；`detectPlannerRoute` 按 `auto | session | off` 选路（`auto` 默认，有缓存证据才走 A，无证据时行为与过去完全一致）；`buildPrefixMessages` 从会话事件尾偏重建 user/assistant 文本消息（`plannerPrefixMaxChars` 默认 12000 字符封顶），user 消息盖 `user` 源、assistant 消息盖调用 agent 自身的 provider/model（不伪造 `replayState`，非文本块丢弃）。

Route A 把扁平轨迹块换成结构化消息前缀：`streamText` 新增 `prefixMessages` 拼到用户消息之前，规划器去掉自动提取的 `<session_trajectory>`（调用方显式传入的 `trajectory` 保留），门禁去掉 `<conversation>`；前缀为空时回落 Route B。Route B 与过去逐字节一致。配置进 schemastery：`plannerPrefixCache`（`auto` 默认）与 `plannerPrefixMaxChars`（12000 默认），门禁经 `AutoReviewConfig` 透传，`/evolve plan` 命令路径用默认值。

## Alternatives considered

- **完整复刻上游 Route A（`deriveMessages` + host tools/sessionId 还原字节级缓存键）**：落败。上游为 dsh 0.1.5 的 loop 请求形状而写，本地 0.1.7 seam 没有 `deriveMessages`/request-header 管道；字节级复刻属于版本敏感的深集成，缓存命中收益不确定，风险先行。当前是有损但诚实的子集（来源如实标记、缩减处文档声明），等 seam 允许再升级。
- **只做检测不上路由**：落败。无行为的检测是死代码，测试也只能断言布尔值；路由 + 双路行为才是完整功能。
- **Route A 同时发送前缀与扁平文本（双保险）**：落败。同一证据发两份是最坏情况——全价计费且上下文翻倍；前缀是扁平块的超集（同源、更宽 cap、保角色），去重才是省 token 的本意。

## Consequences

门禁与规划器在有缓存证据的会话里输入更便宜（命中时）且 grounding 更好（12k 结构化上下文代替 400 字符摘录/40k 扁平文本）；无证据会话零变化。代价是新增两个配置项与一套路由测试；assistant 前缀消息缺 `replayState`，provider 侧若要求回放状态会降级（实测以 e2e 为准）。

## Testing

`test/prefix-cache.test.ts` 覆盖检测、选路、前缀重建（角色映射、尾偏截断、空块跳过、assistant 落款）与双路接线（Route A 无扁平块且前缀在前、Route B 旧行为、显式 trajectory 保留、前缀为空回落 B）。现有 `planner.test.ts` 零修改通过（默认 `auto` + 无缓存证据 = Route B）。

## Deferred

上游 coordinator 另有两件套未搬：输出预算按 context window 动态折算（`budget.ts`）、Route A 截断回落 Route B 重试。前者需模型元数据管道，后者等真实截断样本再定阈值。
