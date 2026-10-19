# Agent Note: 归档行与隔离行拒绝原地改写

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

写门禁的 update 分支只查"行在不在"，不查行是什么状态。显式 `evolve_write(kind=memory, action=update)` 撞上已归档 id 时，`MEMORIES.updateSql` 没有状态谓词，于是原地改写归档行的 type/title/description/body/scope/not_when，而 `status` 仍是 `archived`。两重后果：①归档快照被改写——同一行的内容与当初折叠/淘汰时的账本快照不再一致，`merged_into` 指向的历史读回来是另一段文字；②提案返回 `ok: true`，模型据此认定记忆已更新，而该行永不进入注入——静默假成功。`quarantined` 行同形：巡检隔离后行留在库里、永不注入，也没有解除隔离的通道，改写同样只会改一份没人读的副本。提取轨不受影响（候选 allowlist 只含 active 行），触达面是显式写入入口。

## Decision

只有 `active` 行接受原地改写。两道门：

- 判词门（`memory-rules.ts` 的 `rewriteBlockedReason`，由 `memory-apply.ts` 的 `updateMemory` 调用）：非 active 行直接按失败处置，判词点明状态，归档行再点明归档原因——`memory "m-a" is archived (review-archive) — only active memories accept rewrites; create a new memory instead`。
- 机械兜底（描述符谓词）：`MEMORIES.updateSql` 追加 `AND status = 'active'`；`Repository.updateRow` 返回实际变更行数，`updateMemory` 见 `changed !== 1` 即按失败处置。谓词把口子焊在 SQL 上，返回值的判定保证"0 行"不会被读成成功。

其余路径原样：active 行的实质变化仍走 M1 版本行（`planMerge`），仅重指 `corrects` 的非实质变化仍原地写（`changed = 1` 的正路）；`delete` 不变（删行不产生"改了却读不到"）；提级/降级/复核归档走各自的专用 SQL，不经过 update。归档与隔离都是终态，本批不提供复活或解除隔离的通道。

## Alternatives considered

- **复活语义（update 命中归档行时翻回 active）**：能字面满足"更新这条记忆"的意图，但必须逐原因定策——`merged-duplicate` 复活会与其后继 active 行重复并撕裂 `corrects` 链，`promoted-source` 复活会与全局行双活，`review-archive` 复活等于推翻复核判词；还要继承 `probation_until`/`origin_workspace`/usage，并在卡片归档区加动作。等于在写门禁里塞一台状态机，远超本条守卫的范围。落败（将来要做按 `archive_reason` 分策单独立项）。
- **只加 SQL 谓词、不加判词**：改写失败退化成 0 行静默（`updateRow` 原本吞掉 changes），提案照样返回成功——正是要消灭的假成功形态。落败。
- **把状态守卫下沉到 `Repository.updateRow`（不匹配即抛）**：`applyProposals` 的循环没有 try/catch，异常会留下未提交的 `BEGIN`，事务悬挂；且 skills/prompts 的描述符没有状态谓词，抛错把改动面扩大到三个 kind。落败（判词留在写门禁，谓词留在描述符，判定靠返回值）。

## Feedback edge

无回边：写门禁的拒绝判词只回到调用方（工具结果与账本的 `rejected` 行），不新增常驻机制、无读者动作。判词进账本「first failure」字段，查账人据此区分"没有这行"与"这行已冻结"。

## Consequences

显式 update 命中归档或隔离 id，从"假成功 + 改写历史"变成"整批 reject + 判词"，批次原子性照旧（一条失败全批回滚，落 `rejected` 账本行）。代价：想更新已归档记忆只能换新 id 重建（内容重复由 M2 同会话同标题与 body 去重门兜底），或接受历史是终态；隔离行从此不可改写，修正内容同样只能重建。

公开面写了这条拒绝面：双语 README 的「唯一写路径」门禁清单与 `evolve_write` 的 `action` 参数描述都点名它，模型在调用前就知道、不必靠拒绝判词事后学。

模块预算随本变更重定基线（`budget-baseline.json`）：`services/memory-rules.ts` +17 行（新增状态门）、`data/repository.ts` +7（`updateRow` 返回变更行数）、`data/resource-kinds.ts` +4（状态谓词与其注释）、`services/memory-apply.ts` +1（判词接线与 0 行判定，values 数组压两行换回空间）。

## Testing

`test/archive-reason.test.ts` 新增「rewrites stop at frozen rows」五条：归档行改写被拒且 body/title/status/archiveReason 原样；提级来源行的判词带 `promoted-source`；隔离行改写被拒；active 行仅重指 `corrects` 仍原地落地；描述符谓词直连 `memories.updateRow` 对归档行返回 0。全仓 945 测试 / 77 文件全绿。
