# Agent Note: 评审失败留痕与账目完整性

Status: implemented

> 放置路径：`.agents/notes/implemented/bug-fix/2026-10-14-review-failure-trace-and-accounting.md`
> 触发事件：2026-10-14 真库 `review_daily` 出现只有 `reviewed` 有值、其余计数器全 0 的当日行，9 条同日 `review_log` 行却都是正常 `keep` verdict——批次跑过，账目却只落了一半，且失败无任何痕迹。

## Problem

评审批次的写入分成两条互不覆盖的路径：

1. **逐条扣额度**：`consumeReviewBudget` 在每条开跑前 `reviewed = reviewed + 1`。
2. **收尾合并**：循环结束后 `mergeDaily` 一次性把 `new_items` / `requeued` / `approved` / token 加上去。

因此只要异常发生在「第一批条目已扣额度、收尾合并还没跑」之间，就会留下 `reviewed` 有值、其余全 0 的半截行，而：

- 收尾合并是**账目动作**，不写 `review_log`，评审行由链上的 link 写——所以"合并没跑"在库里天然无痕；
- 调度器 `drain` 的 `catch` 只调 `logger.warn("review drain failed: …")`，而实测该 profile 下插件的 `ctx.logger` 输出**不落** `~/.dsh/logs/host.log`（该文件只有 shell/host/update/supervisor/tray/nav/bootstrap/health/cli-shim/caption-bar 这些 scope，插件 scope 0 行）——于是连日志这条线索也是断的；
- 链上只有**模型侧**失败（门/贵门 LLM 与解析）被降级成 skip 行，任何**代码侧**异常（store 写失败、wiring bug）会直接冲出 `runReviewBatch`，同一批次余下条目连同整批账目一起丢失。

结论：一次失败同时丢掉了**钱账**与**原因**，事后只能靠一条不合常理的日行反推。

## Decision

三处改动，都是"把失败记成值"这一既有纪律的补齐：

1. **单条失败兜底**：`runReviewBatch` 的每条处理包在 `try` 里，异常降级为一条 `review_log` skip 行，`reason = "review-failed: <错误首行，≤120 字>"`，并计入当日 `skipReasons` 桶；批次继续走下一条。链上原有模型侧降级不变。
2. **账目必达**：整个循环外再包一层，`mergeDaily` 放进 `finally`——无论循环正常结束、`break`（额度用尽）还是抛异常，当日计数都会合并；异常在合并**之后**重新抛出（fail loud 不变），所以再也不会出现"只有 reviewed"的半截账。
3. **drain 级留痕**：调度器的 `drain` 在成功时记 `review drain: reviewed N, approved M, …`，失败时先 `warn` 错误原文，再把 `drain-failed: <错误首行>` 写进当日 `review_daily.skip_counts`（持久、可回读）；若连这次记录也失败，再 warn 一次"failure not ledgered"。额度用尽的静默跳过也改成一条 info。

日志与台账分工明确：**logger 是实时通道，库是持久通道**。插件 logger 在当前部署下不可回查，因此凡是需要事后复盘的事实，一律写进库（`review_log` / `review_daily`）。

## Alternatives considered

- **只在 `catch` 里补 `logger.warn` 的措辞**：治不了病——logger 在当前部署下没人能读到，且账目仍然是半截。落败。
- **给 `review_daily` 加错误文本列**：为一次失败扩一张表、动迁移与卡片/统计面，收益不抵复杂度；`skip_counts` 已能承载带文本的原因桶。落败。
- **失败即中止整批并保留已扣额度**（不做单条兜底）：失败成本从"丢一条"变成"丢一批"，且额度已被扣掉，账目更难看。落败。
- **把 `mergeDaily` 改成逐条增量写**（每条一次 UPDATE）：写下更频繁、且仍不能解释"为什么失败"；`finally` 一次合并已足以保证完整性。落败。
- **在插件里自己写日志文件**（绕过宿主 logger）：越出插件边界（文件 exporter 属宿主/部署层），且会与将来的宿主 exporter 形成第二真相源。落败。

## Consequences

- 单条异常不再吞掉整批：该条留 `review-failed: <原文>` 行，余下条目照跑，当日账目完整。
- `review_daily` 从此可与 `review_log` 对账：`reviewed` 与 `new_items + requeued` 在正常情况下必须相等，异常批次也留有 `review-failed` / `drain-failed` 桶可查。
- 已知未覆盖：若失败发生在 store 本身不可写（SQLite 打不开/磁盘满），durable 记录同样写不进去，此时只剩 logger——这条边界写在实现注释里，不静默。
- 验证：397 测试（新增两条回归：单条失败留痕且账目完整、drain 失败落进当日 rollup）/ typecheck / oxlint / 覆盖率 96.31-90.87-100（门限 91/83）。
