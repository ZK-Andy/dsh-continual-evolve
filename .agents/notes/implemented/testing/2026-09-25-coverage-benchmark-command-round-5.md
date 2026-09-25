# Agent Note: 覆盖率第五轮（benchmark-command 错误分支）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-benchmark-command-round-5.md`

## Problem

第四轮后 `benchmark-command.ts`（语句 90.06 / 分支 75.62）是语句最低线；缺口分两簇：各子命令的 `not found` / 空 case / 非法参数错误分支，以及 scoreboard 展示分支（`??` 回退、三态 decision、空板）。

## Decision

- +19 例（29→48）：裸参数四则（add-case/status/run/freeze/meta）、ghost 基准与 case（casecheck/pilot/freeze/meta）、空基准 casecheck、裸 `candidate` 关键字走 reference 路径、缺 meta 文件视为 draft、恰 1 问题单复同覆盖（casecheck/freeze）、pilot 三态（session 行/failed 零分/空 evaluation unknown/below-threshold）、list 有 reference（`ref=90`/`ref=?`）、status 空 overall＋裸 candidate＋ACCEPTED 空理由 decision、null-overall reference 的二次运行报错、autoCase 开启的拒绝捕获。
- 删一处死代码（行为不变）：status 的 `|| "(empty scoreboard)"`——reference 有无两臂必 push 一行，join 永真。
- 仍 decline（有证明）：auto-case capture catch（tmpdir 内被调方无失败源）、aggregate 展示 `??`（过滤后值恒为 number，类型残留）、pilot 重载 meta `??`（transition 在重载前必物化缺失 meta）。
- 水位线棘轮：90/91/90/75 → 91/91/91/75（新最低线 validate 语句 91.24；分支仍 wrapup-command 75.6、函数仍 logfile 91.66）；双语 README 徽章 913/97/86/99 → 932/97/87/99。

## Alternatives considered

- **为三个 decline 点写 mock 硬凑**：被调方在测试宇宙内无失败源（captureAutoCase 的 addCase 在 tmpdir 必成功；loadCaseMeta 缺失必经 transition 物化），mock 抛错测的是 mock 而非接线。落败。
- **保留 `(empty scoreboard)` 回退**：构造性证明永不可达（两臂必 push），保留只压分支水位。落败。
- **分支水位同步上移到 76**：最低线 wrapup-command 75.6 与 benchmark-command 75.62（现 97+，已非持有者）仍卡 75；棘轮保持"永远绿、只上移"。落败。

## Consequences

- 收益：932 测试（+19）；`benchmark-command` 语句 90.06→99.4、分支 75.62→98.4；全仓 97.48 / 87.44 / 99.51；三项 100 文件 8 个。
- 代价：语句最低线移至 `validate`（91.24）；分支 87 距 DSH 100 仍远。
- 后续：第六轮主战场 `validate`（91.24）与 `wrapup-command` 分支（75.6）；`../` 前缀口径仍待产品拍板。

## Testing

- `pnpm test` 932 全绿；per-file 水位线 `pnpm test:coverage` 全绿（含新 91 线）；tsc（含 scripts）/oxlint/TS 四门禁全绿。
- 死代码删除后 status 空板用例（既有）仍绿，live 路径未动。
