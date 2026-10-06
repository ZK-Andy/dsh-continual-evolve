# Agent Note: 卡片默认工作区 = 宿主当前工作区（`defaultRoot`）

Status: implemented

## Problem

v0.15 换存储时，"卡片打开时选中哪个工作区"这条语义被悄悄换掉了，用户实测报出："卡片一直显示 desktop，我从 work 工作区切到插件，不是应该默认显示 work 吗？"

链条（三处都对，合起来错）：

- 客户端选中态初值是 `{root: null}`，且只活在组件内存里（`client/client.js`）；`null` 时取**列表首条** `workspaces[0].root`。
- 列表来自 `/workspaces`，v0.15 起是库查询 `SELECT workspace_id … GROUP BY workspace_id ORDER BY MAX(updated_at) DESC`（`store.ts`）。
- 库里 desktop 的最后写入是 `2026-10-05T22:48`（一条 import），work 是 `22:29` → desktop 排第一。

v0.14.x 的列表源是宿主工作区注册表（stable registry order），换成库之后，"首条"的含义从"注册表里第一个有库的工作区"变成了"最近写过记忆的分区"。**没有任何一次变更决定过"默认选哪个"**——它一直是"首条"这个隐式规则，换源即失效。这正是 OBSERVATION 里那条教训（验收必须覆盖**数据源**）的再次发作：v0.14.1 的 ADR 把目录源写成决定，却把默认选中留在了隐式规则里。

对照证据（本机 `~/.dsh/storages/workspace.json`，8 条记录）：`/mnt/work/work` 的 `updatedAt` 是 `2026-10-06T00:47:30Z`（重启后本会话 attach 的瞬间），`/mnt/work/dotnet-deepseek-harness-desktop` 是 `2026-10-05T22:48:07Z`——"最近有会话活动的工作区"恰好就是用户期望的 work。

## Decision

- **默认值显式化**：`/workspaces` 响应增加 `defaultRoot: string | null`。取值链两级：①宿主当前工作区——`ctx.get("workspaceRegistry").list()` 里 `updatedAt` 最新记录的 `path`（逐请求解析，卡片开着时新建/attach 的工作区刷新即生效）；②库内"最近活动"分区——`store.mostRecentlyActiveWorkspace()` 取"账本最大 `ts`"与"记忆最新 `updated_at`"中更晚者（账本每次运行都记一行，含 skip 与显式写；记忆写是其被裁掉后的durable 兜底）。两级都取不到或不匹配时为 `null`，客户端退回首条。
- **只在已列出集合里认账**：`defaultRoot` 必须是 `/workspaces` 已列出的分区之一，否则忽略该候选。列表是库投影（也是读围栏），列表外的 root 一律不可读——宿主指到哪儿都不放行。
- **拼写差异先归一**：`canonicalPath()`（`fs.realpath`，失败则 `resolve`）比对注册表路径与分区 id，兼容"注册表存 realpath、分区 id 是会话 cwd"这一档 symlink 拼写差。
- **客户端**：初值顺序 `selection.root → defaultRoot（须在列表内）→ 首条`；用户手选只活在本次渲染内，**不持久化**（本次拍板）。
- **注册表只作默认提示**：读围栏与列表仍是库投影，v0.15 ADR 的"目录探测 + 注册表链路退役"不因此复活——那条退役针对的是目录源与围栏，不是一次性的默认提示。注册表服务不进 `inject` 列表（走 `ctx.get`，FAQ #2），否则缺服务会连卡片一起不挂。
- **列表顺序不动**：展示仍是"最近写入优先"，默认值与排序分开表达。

## Alternatives considered

- **只把列表排序改成"最近活动"，默认仍取首条**：改动最小（一行 SQL），但"默认=当前工作区"依旧是隐式规则——正是本次事故的成因，下次换源还会翻车。落败。
- **客户端自己推导当前会话的工作区**（接宿主客户端 `workspaces`/`sessions` store，复刻 GUI 的 `mainReference` 规则）：最贴字面，但耦合的是 GUI 内部导航服务（非公开契约），宿主升级即静默失效；且卡片是插件管理页，本身不属于任何会话视图。落败。
- **插件自记"最近活跃工作区"到 `state`**（注入时写）**：** 无宿主依赖，但"切了工作区还没发消息"这一档会滞后，且引入自造状态——v0.14.1 ADR 已否决过同类"自建最近工作区持久化"。注册表是"新会话 attach 即 durable 更新"的宿主真源，更快也不新增状态。落败。
- **客户端 `localStorage` 记住用户上次手选**：用户本次明确不要。落败。
- **把 `defaultRoot` 排到列表首位**：会与"最近写入优先"的展示语义打架，刷新时列表跳动。落败——默认值与排序是两个问题。

## Consequences

- 卡片在 work 工作区打开即选中 work（本机数据：work 的注册表 `updatedAt` 比 desktop 晚 2 小时）。
- 兼容两个方向：老客户端遇到多出的 `defaultRoot` 直接忽略；新客户端遇到老服务端拿不到该字段→退回首条，与旧行为一致。
- 宿主无注册表服务、或服务抛错/结构异常时，默认回退到库内最近活动分区，仍比"首条=最近写入"更贴近"当前"；提示函数与存储查询都包了 try/catch，路由不会因默认值失败（沿用"handlers never throw past the response"）。
- 读围栏与安全面零变化：`defaultRoot` 只是"选中哪个"，不新增可读 root。
- 测试 173 → 190（15 → 16 文件）：新增 `test/workspace-hint.test.ts`（注册表形状解析 + canonical 路径）、`store.test.ts` 的最近活动分区 4 例、`card-routes.test.ts` 的默认值 4 例、`client-card.test.ts` 的默认选中 2 例 + `loadCardModel` 透传 1 例、`plugin.test.ts` 的注册表异常兜底 1 例。
- ADR `2026-10-06-sqlite-single-store` 的"卡片改查库"表述不因此改写：查库仍是列表与围栏的唯一来源，本决定只补上它当时没决定的"默认选中"。
