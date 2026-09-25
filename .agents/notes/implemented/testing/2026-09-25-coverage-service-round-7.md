# Agent Note: 覆盖率第七轮（service 引擎咽喉）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-service-round-7.md`

## Problem

第六轮后 `service.ts`（语句 91.72）是语句最低线。缺口是引擎咽喉的 containment 路径：post-commit 历史/钩子失败携带、投影失败吞掉、冲突屏蔽的未命中臂、warn 印章跳过。

## Decision

- 新文件 `test/service.test.ts`（+7 例，引擎级 tmpdir 真机）：未知 kind 跳过相似 corpus、缺标题/正文空屏蔽、warn 印章在 warned 编辑未落地时跳过、EISDIR 历史追加失败携带已持久化结果、投影 ENOTDIR 被吞且应用成功、钩子抛 Error 与抛 string 均携带结果。
- `service.ts` 语句 91.72→98.5、分支→96.4；全仓 97.91 / 88.2 / 99.51（分支徽章过 88 整数关）。
- 仍 decline（有证明）：两处 prune catch（被调方内部全包裹永不抛）、append 的 `String(cause)` 臂（真实 FS 抛错恒为 Error）。
- 水位线本轮不动（91/91/91/75）：语句最低线移至 store 92.38，未过整数关。
- 双语 README 测试数 943→950、分支徽章 87→88。

## Alternatives considered

- **mock store.js 硬凑 prune catch**：被调方真身永不抛，mock 抛错测的是 mock；且 service 自身注释已写明 best-effort 语义。落败。
- **水位线象征性 +1**：store 92.38 不满足 92。落败。
- **把 service 测试并入 apply.test.ts**：引擎咽喉行为（containment/携带）与单条应用语义不同层，独立文件与 plan/render先例一致。落败。

## Consequences

- 收益：950 测试（+7）/ 54 文件；三项 100 文件 9 个（service 差 2 语句 3 分支，均为已裁定项）。
- 代价：分支 88 距 DSH 100 仍远；下一最低线 store（92.38）与 wrapup-command 分支（75.6）。
- 后续：第八轮主战场 `store`（92.38）；`../` 前缀口径仍待产品拍板。

## Testing

- `pnpm test` 950 全绿；per-file 水位线 `pnpm test:coverage` 全绿（91/91/91/75 原线）；tsc（含 scripts）/oxlint/TS 四门禁全绿。
