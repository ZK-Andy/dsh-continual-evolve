# Agent Note: 评审门预算截断与失败判死

Status: implemented

> 放置路径：`.agents/notes/implemented/bug-fix/2026-10-13-review-gate-budget-and-requeue.md`
> 对应讨论结论（2026-10-13 会话）：门失败既有路由抖动也有预算截断，且失败行会判死条目——两者都在评审环跑通前必须修。

## Problem

2026-10-13 对两条轨的失败账全量核对：提取轨 23 条 `cheap_error` 里 16 条是 `stream finished with error`（路由/网关抖动，集中成几个分钟级窗口），**7 条是 `stream finished with max-tokens`**。两类死因指向两个独立缺陷：

1. **门预算不足且截断被当成致命**。两条轨的门额度都是写死的 512（`review.ts` 与 `extraction.ts` 各自的 `streamOnce` 调用点），而带推理的模型把预算花在 reasoning 上（账本里 reasoning 98–252 token 是常态）。`streamOnce` 对 `finish.kind !== "stop"` 一律抛错，于是**即使 verdict JSON 已经完整输出**，整条调用也被丢弃并记成 `gate-llm-failed`。骨牌效应是诊断被带偏：v0.15.9 据此把门死因判为「路由/网关故障，不是预算、不是模型选择」（原先写在 [2026-10-12-extraction-gate-failure-ledger.md](../architecture/2026-10-12-extraction-gate-failure-ledger.md)），而全量数据表明其中约三成是预算截断。
2. **失败行会判死条目**。`reviewStateOf` 取 `review_log` 里任意一行作为「已评审」，`gate-llm-failed` 的行同样算数，条目因此在 `staleDays`（30 天）内不再入选候选。实测：手工清掉 8 条失败行后，`project-is-self-evolving-plugin` 下一轮又撞门失败、又被锁回原状。提取轨早有「失败不推游标」的纪律，评审轨在这一点上自相矛盾。

## Decision

- **门预算 512 → 1024**（两轨各自的 `GATE_MAX_TOKENS` 常量）：门输出只有一个 verdict JSON，1024 覆盖推理余量而不是无脑放大；贵调用维持 4096。
- **截断的裁量权交给调用方**：`streamOnce` 不再替调用方抛截断错误，改为返回 `{ text, usage, finish }`；只有「文本为空」仍按 `finish` 原因抛出。
- **门：先解析、后归因**。解析成功就用（截断前已完成的 verdict 算数）；解析不出且 finish 非 `stop` 时才记失败（`stream finished with max-tokens` 照旧落 `reason`/`cheap_error` 原文）。
- **贵调用保持严格**：evolve 改写与提取主调用产出的是完整正文/提案，`finish !== "stop"` 一律失败——半截内容永不落盘。
- **失败行不算「已评审」**：`reviewStateOf` 的 `reviewLast` 语句排除 `gate-llm-failed*`、`evolve-llm-failed*`、`no-route`、`budget-exhausted`、`gate-parse-failed`、`evolve-parse-failed` 六类（`store.ts` 的 `INCOMPLETE_REVIEW_SQL`）。门的有效拒绝（cheap-gate 的自由文本 reason）与 keep/rewrite/quarantine 仍算完成。

## Alternatives considered

- **只把预算提到 2048/4096**：门输出只是一个 JSON，放大预算治标不治本——不修「截断即弃」的话，任何未来截断仍会丢掉已经完整的 verdict。落败。
- **门也维持「非 stop 即失败」**：等于让推理模型正常撞预算这件事持续制造假故障。落败。
- **给 `review_log` 加「是否完成」列**：多一次迁移与写路径分叉；失败原因集本身稳定封闭，SQL 谓词够用。落败。
- **失败行完全不落账（只 warn）**：丢掉诊断线索——本次正是靠 `reason` 原文把 `max-tokens` 从「网络故障」里分辨出来。落败。
- **把 `staleDays` 调小来缓解判死**：治标——失败仍会刷新 `lastTs`，且模型侧更新正文本就不触发重评。落败（配置化另行处理，见同日 feature 笔记）。

## Consequences

- 门失败率不再等价于「漏评」：路由抖动仍会记账，但条目留队，下一轮自然重试。
- 门在推理模型上的正常截断不再吞掉有效 verdict；提取轨同样受益，其 fail-open 语义不变（门不清不楚就透传给贵调用）。
- 同一 item 在 `review_log` 里可能留下多行失败 + 一行结论，这是有意的审计形状，不是重复记账。
- 代价：一次真实的坏路由会让同一条被反复重试，直到成功或用户修好链路——由上界（`minIntervalMs` + 日预算）框住，不会失控。
- 验证：337 测试（+4：截断仍可用 / 截断无 verdict 记失败 / 失败行不判死 / 设置热读）/ typecheck / lint / 覆盖率 96.14-89.74-100（水位线 91/83）。
