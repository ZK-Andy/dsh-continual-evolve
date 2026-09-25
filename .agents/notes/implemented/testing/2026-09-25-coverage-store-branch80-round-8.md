# Agent Note: 覆盖率第八轮（store + 分支 80 关）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-store-branch80-round-8.md`

## Problem

第七轮后语句最低线是 `store`（92.38），分支 80 下还有 4 个文件（turn-snapshot 77.04、logfile 77.55、mount 77.77、review 78.04）。另发现前序交接沿用的"wrapup-command 分支 75.6 持有者"已过期——第六轮已将其提到 90.9，实测分支最低线是 memory-agent 80.68。

## Decision

- `store` +6 例（文件/悬空链接/目录冒充三种不可读形、混合历史行、路径变体）：语句 92.38→99.0、分支→98.5。
- `turn-snapshot` +9 例：projectKey/skipReason 捕获展开、畸形事件五式、混合序列化、截尾、双读表回退、seq/index 全边界形状、标量 content、junk 行 seq 过滤：语句→100、分支 77.04→100（单 slot 余量为全量跑噪音内）。
- `logfile` +5 例：无栈 Error 回退、稀疏记录三形、显式 level、rename 失败穿透、exporter 吞错：语句→100、分支 77.55→98.2。
- `mount` +5 例：non-array ledger、guidance 无合约渲染、非对象 contract、string 版 loader 三错、空 reference 拒绝：分支 77.77→98.4。
- `review` +6 例：fenced 非对象拒绝、默认 rationale、双缺路由抛错、序列化跳过三形：语句→100、分支 78.04→96。
- 仍 decline（有证明）：store 写 catch（同路径读写、root 下无确定触发）、review provider/model 展开 else（L152 抛错使之不可达）、logfile `type[0]` 微臂 + `export` 存根（cordis 4.0.4 源码确认 format 永不调用，类型必需）、logfile 函数 91.66 即此存根。
- 水位线：91/91/91/75 → 91/91/91/80（分支最低线 memory-agent 80.68，过期 wrapup 口径同步更正）；双语 README 徽章 950/97/88/99 → 983/98/90/99。

## Alternatives considered

- **为 store 写 catch / export 存根造 mock**：前者被调方真身在同路径读写下永不抛，后者连 cordis 宿主都不调用——mock 抛错测的是 mock。落败。
- **分支水位一步到 85**：recall 81.01、project 81.25 等 8 文件仍在 85 下，一步提会红。落败。
- **重写前序交接的过期口径**：交接是追加日志，不改历史；本记正本清源，后续以实测为准。落败（不改）。

## Consequences

- 收益：983 测试（+33）；全仓 98.19 / 90.03 / 99.51；分支首次过 90；三项 100 文件 13 个。
- 代价：函数 99.51 卡在 logfile 存根 + auto 私有函数两处已裁定项；分支 90 距 DSH 100 仍远。
- 后续：第九轮主战场 `projection`（语句 92.4）与分支 85 线（recall/project 等 8 文件）；`../` 前缀口径仍待产品拍板。

## Testing

- `pnpm test` 983 全绿；per-file 水位线 `pnpm test:coverage` 全绿（含新分支 80 线）；tsc（含 scripts）/oxlint/TS 四门禁全绿；`coverage-gaps --self-test` 通过。
