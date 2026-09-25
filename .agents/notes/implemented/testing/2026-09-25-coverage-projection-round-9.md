# Agent Note: 覆盖率第九轮（projection 主战场出坑）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-projection-round-9.md`

## Problem

第八轮后语句最低线是 `projection`（92.4，73/79），分支 29/33（87.9）。`coverage-gaps` 定位缺口四处：文件名碰撞后缀（L51-53）、readdir 回退（L65-66）、unlink 回退（L71-74），另有排序比较器分支（L41）。

## Decision

- `projection` +3 例（真机 tmpdir，零 mock）：冒号映射碰撞（`a:b` 与 `a_b` 同映 `a_b.md`，第二取 `~2` 后缀）、陈旧目录扫尾（`stale.md` 子目录使 unlink 抛 EISDIR 被吞）、不可读 facts 目录（chmod 000 使 readdir 抛 EACCES 回退空集后仍写索引）：语句 92.4→100、分支 87.9→96.9。
- decline（有证明）：排序比较器相等臂 `: 0`——`entries.memory` 以 id 为键，`Object.values` 无重复 id，比较器永不见相等；单线程内自比较不发生，与 fate forget-vanished 同类不可达。
- 水位线不动（语句最低线移交 memory-agent 95.9；分支仍 memory-agent 80.68；函数仍 logfile 存根+auto 私有）；双语 README 测试数 983→986，徽章语句/分支/函数保持 98/90/99。

## Alternatives considered

- **为排序相等臂构造重复 id**：state 以 id 为键，重复键在对象层面不可能存在——造的是类型违背，不是行为。落败。
- **为 readdir/unlink 回退造 mock**：EACCES（chmod 000）与 EISDIR（子目录冒充文件）均有真机触发源，mock 测的是 mock。落败（未用）。
- **顺手把分支 85 线一起收了**：recall/project 等 8 文件仍在 85 下，与本轮主战场无关，分轮次保持 diff 最小。落败。

## Consequences

- 收益：986 测试（+3）；`projection` 三项 100/96.9/100；三项 100 文件 14 个（语句维度）。
- 代价：分支 96.9 距 100 差一不可达臂，属已裁定项。
- 后续：分支 85 线（recall/project 等 8 文件）为第十轮主战场；`../` 前缀口径仍待产品拍板；函数 99.51 两处已裁定项不变。

## Testing

- `pnpm test` 986 全绿（54 文件）；per-file 水位线 `pnpm test:coverage` 全绿；tsc/oxlint/TS 四门禁全绿。
