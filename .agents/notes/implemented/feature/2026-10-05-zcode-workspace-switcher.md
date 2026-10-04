# Agent Note: 卡片工作区选择器对齐 ZCode（目录源 + 下拉作用域）

Status: implemented

## Problem

v0.14.0 把卡片内容对齐 ZCode 记忆选项卡时，"每个工作区一次选一个"落地成了 **chips**，其数据源是 section 注入顺带记录的"本进程服务过的根"（`known-workspaces.ts`，进程内 LRU 8）。两处都错，且失败态静默：

- **目录源错**：那不是一份工作区目录，而是注入路径的副产物——它本来是 API 的**读围栏**，被顺手当成了选择器的数据源。
- **形态错**：ZCode 的记忆选项卡用下拉作用域菜单（`packages/ui/src/settings/PluginScopeMenu.tsx`：圆角 Button 触发 + 图标 + 当前工作区名 + chevron），不是一排 chips；且它在只有一个作用域时也照常渲染。
- **失败态静默**：chips 只在 `workspaces.length > 1` 时渲染（`client/client.js`）。dotnet-desktop 日常只服务一个工作区（实测 `/api/v1/workspaces` 只回 1 条 `/mnt/work/work`）→ 整块 UI 不渲染、无占位无禁用态，选择能力看起来"根本没实现"。

根因是结构错配：ZCode 的项目记忆集中在数据根下（`getZCodeDataRootDir()/cli/memories/projects/<slug>-<16hex>/memory/`，`listProjectMemories()` 扫一遍目录即得全量目录），而本插件的记忆是**每工作区一份**（`<root>/.evolve/memory`），没有可扫的单一根，必须外接一份工作区目录。当初的需求只记成"工作区选择"四个字（[2026-10-05-zcode-memory-viewer-card.md](2026-10-05-zcode-memory-viewer-card.md)），没写目录源与形态，实现取了手边唯一现成的列表。

## Decision

- **目录源接宿主注册表**：新增 `src/workspace-catalog.ts`；目录取 `ctx.workspaceRegistry.list()`（`@deepseek-ai/dsh-workspace` 的 durable 记录，stable registry order——与 GUI 的工作区选择器同源），条目 `{id, path(realpath), title}`。渲染名取 `title`，缺则取目录名。
- **两级回退**：注册表服务不可用（老宿主、注入不到）时读 `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`；两者皆空时退回进程内 served 根。三源按 canonical path 去重，注册表条目在前。
- **两个问题两个方法**：`known()` 是读围栏（这个根能否读），`list()` 是展示投影（此刻有记忆目录者）。列表按 ZCode 规则只列"有 `memory` 目录"的工作区（plain directory、拒 symlink）；围栏**不能**跟着这个过滤走——列表与读取之间被删掉的库必须降级成该条目的空态，而不是 404。
- **服务每次请求解析**（`ctx.get("workspaceRegistry")`，取不到即回退），所以卡片开着时新建的工作区，点刷新就出现；这也让上一版修好的刷新按钮真正有意义。
- **选择器改 ZCode 形**：`WorkspaceScopeMenu` 替换 chips——圆角触发按钮（primitives 的 `IconChevronsUpDownOutlineRegular` 作前导标记 + 当前工作区名 + chevron；老宿主降级为同主题裸 button）、`role="menu"` 面板、`role="menuitemradio"` + `aria-checked` 选项（第二行显示根路径——注册表允许重名标题）、选中/Escape/点击外部关闭。**只要有一个工作区就渲染**。
- API 与文案：`/workspaces` 条目由 `{root,lastSeen}` 改为 `{root,label}`；空态文案改为"还没有任何工作区有记忆库"。

## Alternatives considered

- **保留 chips，只换目录源**：多工作区时确实能切了，但仍与 ZCode 差一层形态，且单工作区时依旧什么都不渲染——正是用户看到的现象本身。落败。
- **chips 改为"1 个也渲染"**：修掉"看不见"，形态仍不是 ZCode 的下拉。落败。
- **以注册表文件为主、服务为辅**：少一层服务依赖，但那份 JSON 是宿主 domain data form 的内部格式（UUID 键 + spec 版本），格式漂移会静默丢目录；服务由同一个模块提供且承诺 stable 顺序。落败——服务为主，文件仅作老宿主回退。
- **围栏直接等于"有记忆目录"**：围栏随磁盘状态漂移，列表→读取之间目录被删就成了 404 错误条目；ZCode 语义是"该工作区没有库"。落败——围栏用注册表根，展示层再做存在性过滤。
- **只列注册表里的根，不并 served**：更干净，但会话所在工作区若尚未进注册表就整块消失。落败——并上 served 根并去重。
- **自建"最近工作区"持久化**（v0.12 卡片笔记已否过一次）：引入第二个磁盘状态，且仍是自造目录而非宿主真源。落败。

## Consequences

- 选择器与 GUI 同源。真实注册表数据实测：围栏 8 条、列表 2 条（`work`、`dotnet-deepseek-harness-desktop`；其余工作区尚无记忆库，按 ZCode 规则不列）。
- **只列有库的工作区**意味着从未用过记忆的工作区不出现在列表里（ZCode 同），空态文案已按此改写。
- **围栏从"本进程服务过的根"放宽为"宿主注册表里的根"**：读取面仍是"工作区根 + 纯 `.md` 文件名 + 5 MiB 上限"，但确实比 v0.14 宽（放宽到的都是宿主自己已经记录的工作区）。这是本决定的主要安全代价，明确记在此处；[2026-10-04-plugin-management-card.md](2026-10-04-plugin-management-card.md) 的围栏表述已同步改写。
- `known-workspaces.ts` 降级为最后回退源，不再是围栏本身（模块与测试保留）。
- 测试 81 → 91（8 文件）：新增 `test/workspace-catalog.test.ts` 7 例（服务优先/文件回退/去重/坏数据不抛/symlink 库不算/空源）；`card-routes.test.ts` 的围栏与列表形状改写；`client-card.test.ts` 新增选择器 2 例（单工作区也渲染、点选落到 selection 状态）。
