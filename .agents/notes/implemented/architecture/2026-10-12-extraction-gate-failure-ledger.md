# Agent Note: 提取门失败留痕（cheap_error 列）

Status: implemented

## Problem

提取侧便宜预检门在 v0.15.8 上线时只记「门用量」（`cheap_usage`）：门调用成功就记 payload，门自己抛错则 catch 为空。fail-open 语义本身是对的（透传给贵调用，不 stall），但失败不留痕，于是「门整晚都在挂」只能靠 `cheap_usage IS NULL` 反推——而这与「这版还没有门」在账本上不可区分（两者都表现为贵调用行 `cheap_usage` 为空）。

2026-10-12 晚实证：桌面 app 18:44:57 重启（装的 `lib/extraction.js:119` 门带 512 token 预算），此后 22 次全调用中 22 次 `cheap_usage` 为空（模型 `muse-spark-1.3-contributor`，带思考强度），唯一一次命中门的是 `deepseek/deepseek-v4.1-flash`（96 输出 + 54 推理 token）。评审轨在 `414ca90` 起把失败原文写进行里（`gate-llm-failed: <原文>`），提取轨没有对应物；宿主日志也不落请求级错误（同晚 21:30–21:45 全量只有托盘与 shell 代理行），账本是唯一 durable 面。

## Decision

`extraction_log` 增 `cheap_error TEXT` 列，与 `cheap_usage` 配对；旧库走同套单列 ALTER 迁移（`ensureExtractionCheapError`，与 `ensureExtractionCheapUsage` 分函数，已带 `cheap_usage` 的库仍能补上本列）。

门调用抛错时，`errorHead(error)`（`errorText().message` 压平空白、截 200 字符）随该次运行的**终局行**落账：skipped / failed / applied 三条终局路径都带（`logSkipped` 与 `applyProposals` 的 `ProposalContext.cheapError`）。门成功解析、或运行从未跑到门（机械跳过、无路由）时该列为 NULL。

fail-open 语义不变：不消费游标、不 stall、不为门的死亡加行——一次运行仍是一行，终局原因（`skip_reason` / `status`）不被门失败改写，门原文只是同一行上的附加诊断。

## Alternatives considered

- **复用 `files` 列**：把门原文并进既有诊断列。落败：`files` 在 applied 行是审阅 JSON 数组（`{id, action, before?, after?, sourceSeqs}`）、在解析失败行是字符串，形态已多义；再塞门原文会让「查门失败」变成解析 JSON 的分支逻辑，并污染 applied 行的数组语义。
- **每次门失败单开一行**（照评审轨 `gate-llm-failed` 行的样子）。落败：破坏「一次提取运行一行」的账本不变量——运行计数、按游标的审计、日聚合都会多算，且与 model-skip 的连续跳过合并（`COALESCED_SKIP_REASONS`）互相干扰。
- **只写宿主日志（logger / stderr）**。落败：宿主默认不落请求级错误（同晚实证），日志随进程轮转、不可跨会话对账；账本是唯一可长期回查的面。
- **把失败写进 `skip_reason`**。落败：与终局原因混淆，且 applied / failed 行没有 `skip_reason` 该有的位置。
- **同时把门预算从 512 调大**。留作后续独立决定：先拿原文再定（本轮 22/22 失败、唯一成功者余量三倍，原文落地后才能区分「512 截断」与「网关抖动」，避免盲改）。

## Consequences

收益：门失败可见可查（`WHERE cheap_error IS NOT NULL`），且 provider 抛错原文自带 `max_tokens` / `outputTokens` / `reasoningTokens` 数字，直接回答「门是在烧满预算之后死的，还是路由抖动」；`cheap_usage IS NULL` 的两义性消失。

代价：一列 schema 迁移 + 每次运行多写一列；账本行诊断载荷每行最多多 200 字符。

### Testing

`test/extraction.test.ts` 覆盖三条回归：门抛错 + 贵调用 apply → 终局 applied 行带 `cheap_error` 原文、`cheap_usage` 为 NULL、且仍只有一行；门抛错 + 贵调用 skip → 原文压平成一行（含 token 数字）且游标照常推进；旧库迁移断言 `cheap_usage` 与 `cheap_error` 两列齐备。
