# Agent Note: 卡片投影合并全局记忆，补 `scope` 标记

Status: implemented

> 放置路径：`.agents/notes/implemented/bug-fix/2026-10-18-card-global-memory-visibility.md`
> 发现：2026-10-18 00:50 用户目检（「我发现UI卡片上无法看到全局记忆」）；同一会话内提出两个备选，用户选 A（合并进工作区视图）。
> 落地：`src/surfaces/memory-snapshot.ts` 的合并读 + `MemoryFileInfo.scope`、`client/client.js` 的徽标与巡检行分区标记、`test/memory-snapshot.test.ts` 五条用例。**未发版**（发版需用户单独批准）。

## Problem

提级（v0.18.1，ADR `2026-10-13-memory-tiering-and-promotion`）落地后，被提级的记忆**在卡片上彻底消失**：提级事务把来源行置为 `archived`，而卡片只渲染 `status='active'`；全局副本落在 `workspace_id=''` 分区，而卡片的工作区选择器把 `""` 直接跳过（`listCardWorkspaces` 的 `workspaceId === "" → continue`）。

两处各退一半、配对失败：`listAll` 的注释假定「全局分区会自己 Listed」，选择器却假定「全局技能会随任意工作区带出」。技能侧有对应实现（`scopedSkills` 先项目后全局、每条打 scope），记忆侧没有——同一个卡片里两种可见性语义，是缺陷而不是取舍。

危害不止于「少看几行」：注入索引（`store.list`）把 L0 合并进每个工作区，卡片却按分区裁剪，于是**卡片与模型实际看到的东西不一致**，人肉审计失去基准。

## Decision

记忆投影照技能已确立的形状做：`memorySnapshot` 读「本分区 + 全局分区」，每条带 `scope: "project" | "global"`，卡片上以「全局」徽标呈现。

- **合并读的唯一入口**是 `mergedMemoryRows`：先取本分区 `listAll(root)`（非归档行，含隔离行），再追加全局分区中**未被本地 id 遮蔽**的行。
- **遮蔽方向**：本地行遮蔽同 id 全局行（与 `store.get` 的读语义一致）。唯一会出现双份的 id 是被提级过的——其来源行已归档、不出现在 `listAll` 里，所以「还活着的本地行」就是更新的真相。
- **全局分区自读时不叠加**：`root === ""` 直接返回自身，标 `project`（它是自己的视图，不是别人的影子）。
- **无本地行的工作区仍 `exists: true`**：只要全局分区有条目，任何工作区打开都能看到它们（与注入一致），不再误报空态。
- **隔离行带分区**：`quarantined` 条目加 `scope`，卡片在巡检行用「id · 全局」区分同名隔离行。
- **内容预览无需改动**：`memoryEntryContent` 走 `store.get(root, id)`，该方法本就在本地缺失/归档时回落到全局行。

## Alternatives considered

- **备选 B：在卡片选择器里加一个「全局」伪工作区**。落败原因：`rootParamOf` 拒绝空串，要引入哨兵值（`root=global` 之类的伪路径）并让所有卡片路由分支处理它；用户会看到同一条记忆在两个位置出现；且它把「L0 到处可见」这个语义表达成「另有一个地方」。
- **备选 C：在 `listAll` 里合并全局**。落败原因：`listAll` 还被 `review-candidates` 等写入侧消费者使用，在那里合并会把全局行当成本工作区的候选去评审，产生重复判词与错误的归档对象——可见性属于投影，不属于存储读。
- **备选 D：提级时不归档来源行**。落败原因：来源行归档是「唯一 active」与「本地遮蔽」两条不变量的前提，动它等于回退提级事务的设计，代价远大于修投影。

## Consequences

- 卡片与注入索引对「这个工作区有什么记忆」给出同一个答案；提级后的记忆在来源工作区带「全局」徽标继续可见。
- `fileCount` 语义变为「本分区 active + 全局 active（去重后）」，统计行数字会比分区行数大——这是实情，不是 bug。
- 记忆与技能两套投影从此同形（项目优先、全局补齐、scope 标记），以后加第三个资源类型时不用再发明第三种语义。
- 未做：卡片上不显示实习期截止时间与 `origin_workspace`（提级审计要查库或用 `evolve_read`）；是否要让 L0 条目在卡片里可折叠单列，等有真实抱怨再说。

## Testing

`test/memory-snapshot.test.ts` 新增五条：提级后来源工作区仍见全局副本（scope=global、fileCount=1）、本地存活行遮蔽同 id 全局行（scope=project 且只出现一次）、全局分区自读不叠加、无本地行的工作区可见全局并把预览路由一并验到、隔离的全局行带 `global` 标记。全量 `typecheck`/`lint`/`vitest`/`run-gates` 见提交记录。
