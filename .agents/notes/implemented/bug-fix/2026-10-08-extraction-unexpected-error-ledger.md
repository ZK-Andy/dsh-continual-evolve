# Agent Note: 提取轨意外异常账本留痕

Status: implemented

## Problem

`runExtraction` 只有 surface 读取与 LLM 调用两处 try/catch；`store.list/search`、prompt 组装、`applyProposals` 抛错、`setCursor`/`patrol` 写入、账本写入本身抛错时，直达调度器 `drain().catch` 的 `host.logger(...).warn`。而 host 日志连每次启动必打的 info 行都没有落点——既无账本行也无日志落点，等于真静默。另 `surface-read-failed` / `llm-failed` 两行账本只有短因、无错误原文，事后无法定位。

## Decision

- `runExtraction` 包一层 catch-all（原管线迁入 `runExtractionInner`）：任何逃逸异常落 failed 账本行——`skip_reason` 为 `unexpected-error: <message 头 300 字>`（failed 行逐行保留，不参与空转合并），`files` 带 message+stack 头 2KB，model 与 durationMs 俱全；游标不动，下轮触发重试。账本本身也写不进时才 rethrow，且把触发错误与账本错误串成一条链。
- surface/llm 两处内层 catch 同样串链：账本行补 `files` 错误原文，`skip_reason` 保持 `surface-read-failed` / `llm-failed` 稳定。
- 调度器 `drain().catch` 在 warn 前再试一次账本写入（同一 store：瞬时账本故障即重试，排水前序抛错即唯一留痕）；写不进则只 warn，回调本身永不抛错。
- 语义锁定：patrol 抛错时批次已落地、游标已进，失败行与 applied 行并存——失败行不吞没已落地事实。

## Alternatives considered

- **只给调度器 warn 加日志落盘**：落败——host.log 无落点保证，且与"账本即审计口径"原则相悖，排查要在两处找。
- **每个调用点各自 try/catch**：落败——调用点会继续增加，遗漏重演；一层 catch-all 覆盖未来调用点。
- **unexpected-error 参与空转合并计数**：落败——合并只收敛 `no-user-prose`/`no-new-events` 这类机械跳过；故障必须逐行成 timeline（沿用 `COALESCED_SKIP_REASONS` 白名单）。
- **patrol 失败吞掉、当成功处理**：落败——fail loud 红线；此时实际是库已病，吞错等于对病库报平安。

## Consequences

- 任何提取异常事后都可在 `extraction_log` 按 `unexpected-error` / `surface-read-failed` / `llm-failed` 定位到原文与堆栈头；failed 行逐行保留，账本行数微增。
- 测试 194 → 199 例（`test/extraction.test.ts` 24 → 29）；typecheck/lint 全绿。
- **未发版**：随下次发版抵达 dotnet-desktop 的 npm 实体拷贝。
