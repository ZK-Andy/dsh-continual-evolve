# Agent Note: 插件自有日志表（承接方落在库里）

Status: implemented

## Problem

插件的诊断只写 `ctx.logger("continual-evolve")`（24 处：组装根的装配降级与关停、提取调度器的意外异常、评审 drain 的摘要与失败）。cordis 4.x 的 logger 是 exporter 架构，默认只有一个内存 buffer exporter（1000 条环形、无人读），而 dsh 在本机没有接任何 exporter——写进去的 info/warn 不留任何痕迹（见 [FAQ #4](../../../../docs/FAQ.md)）。

2026-10-14 实证：`~/.dsh/logs/host.log` 只含 `[shell]` 前缀的 HTTP 行；插件 mount 时必定打印的 `memory_write and memory_read registered` 在其中匹配 0 次，`extraction`、`review drain` 同样 0 次。

方向不是"让用户装一个 exporter"：**承接方在用户环境里，装不装不归我们控制**，而"能不能回查"是插件自己的属性，不该是用户配置的函数。同时，领域账本（`extraction_log` / `review_log` / `skill_log`）已经把业务事实记全，掉在地上的恰恰是**没有领域行可挂的运维事实**：卡片路由没挂上、section 注入失败、配置关停、调度器意外异常。

顺带暴露第二个缺口：`pruneLedger` 从落地起就没有生产调用者（只在测试里被调用），所以"账本会被裁剪"是 API 的真话、机器的假话——真库 9 天 547 条 `extraction_log`、3 天 115 条 `review_log`。

## Decision

- 库里新增 `plugin_log(ts, level, event, message, workspace_id, session_id)` 与 ts 索引。**level 是枚举字段，不是过滤器**：哪些行入库由调用点决定，sink 不做级别判断。
- 新增 `src/plugin-log.ts` 的 `createPluginLog(storeOf)`：**只写库**，不碰宿主 logger——宿主那面没有承接方，镜像只是把同一行投进一个没人读的缓冲。库未就绪或写失败时**绝不抛**（该行丢弃）：一行诊断不配让会话倒下，而唯一的家就是那张表。
- 调用面收敛：调度器的 host 契约从 `logger(name)` 换成 `log: PluginLog`，组装根的 `HostContext` 不再声明 `logger`——插件对宿主日志通道零依赖。24 处调用点各自给出稳定事件名（`drain-failed`、`card-no-webserver`、`memory-tools-registered` …），于是日志可按事件聚合与计数，而不是逐行读。
- 消息上限 2000 字符（`PLUGIN_LOG_MESSAGE_MAX`，在 store 的写入处截断）：失控的错误原文不许变成一行。
- 保留期：`src/retention.ts` 的 `pruneIfDue(store, now)`——30 天（`LEDGER_RETENTION_DAYS`）、按 UTC 日节流（state 表 `prune:last`）、幂等。`pruneLedger` 现在同时裁 extraction / skill / review / plugin 四张表并返回总数；触发点三个——组装根 store 就绪、写入日志时、提取应用后的巡检处——都不需要新调度器，长活进程自己收口。
- 分工写进 `docs/design.md`：**业务事实进领域账本，运维事实进 plugin_log**，两边不互抄。

## Alternatives considered

- **让用户装 `@deepseek-ai/cordis-plugin-logger-console`**：落败——承接方在用户环境，装不装不归我们管；它仍有价值（前台调试实时可见），但不能是唯一出路。
- **复用现有领域账本记运维事实**：落败——`extraction_log` 的 trigger 枚举、`review_log` 的条目关联都表达不了"卡片路由没挂上"，硬塞会把两张表变成杂物间。
- **给 sink 加级别过滤（只收 warn/error）**：落败——表只声明 level 是枚举；在 sink 里判级别会把"程序控制"变成"配置控制"，多一个真相源。
- **重复行合并计数（照 `extraction_log` 的 occurrences 先例）**：本轮落败——30 天保留已经给了体积上限，先不加复杂度；真库若显示 drain 失败刷屏，再按证据加。
- **只写库、不镜像 logger**（本笔记采用）：宿主通道默认没有承接方，镜像等于把同一行再投进一个没人读的缓冲；插件对宿主日志通道的依赖就此归零。
- **写库后再镜像一份到宿主 logger**（实现中途曾采用、随后删除）：落败——镜像那半句的唯一价值是"有人装了 exporter 时能实时看"，而那属于调试场景（装 exporter 本来就能自己看见），却让每条诊断多一次跨插件调用与一处必须同步的格式。**代价**：store 打不开时诊断无处可写（`store-unavailable` 这条现在不入库，只留代码注释）——唯一日志家就是刚失败的那个库。
- **截断放调用点**：落败——调用点各自为政，表就没有统一上限；上限属于这张表的写入契约。
- **本轮只建表、不做保留期**：落败——那正是 `pruneLedger` 无人调用造成的现状，等于把"无界"从三张表搬到四张表。
- **v1 同时做卡片"日志"区**：落败——没有人要求看见它；"可回查"= 能查库（代理与用户都在查库），界面等真有需求再加。

## Consequences

- 插件诊断第一次在本机可回查：`SELECT ts, event, message FROM plugin_log WHERE level != 'info' ORDER BY ts DESC`。
- 四张账本按同一个 30 天窗口裁剪；`prune:last` 落在 state 表，重启也不会当天重复全表扫。
- 代价：写入路径多一次 try/catch 与一次（节流后的）state 读；store 不可用时诊断无处可写（`HostContext` 也不再声明 `logger`，插件与宿主日志通道彻底解耦）。
- level 枚举与消息上限是表契约，由测试锁住（含截断与"永不抛"）。
- 调用点从 `host.logger(name).warn(msg)` 变成 `host.log.warn(event, msg, where?)`：错误行现在能带 workspace/session 归属。

## Testing

- `test/plugin-log.test.ts`：durable 行（含 level/event/原文/归属）；store 未就绪时丢弃且不抛；写库抛错时不抛；写入顺带跑当日裁剪（预置一条 40 天前的行，写入后只剩新行）。
- `test/plugin-log.test.ts` 的 `pruneIfDue`：同日第二次返回 0；跨日再跑；窗口内的行保留。
- `test/store.test.ts`：`logPlugin` 落行与 2000 字符截断；`pruneLedger` 一并裁掉 plugin_log。
- `test/extraction.test.ts` / `test/review-scheduler.test.ts`：调度器走新的 `log` 面，失败行仍带错误原文。
