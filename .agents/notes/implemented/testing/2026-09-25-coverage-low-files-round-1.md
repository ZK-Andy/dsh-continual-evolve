# Agent Note: 低洼文件覆盖率补齐第一轮

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-low-files-round-1.md`

## Problem

per-file 水位线（`implemented/process/2026-09-25-gate-ts-migration.md`）开门即抓出低洼：`tool.ts` / `wrapup-command.ts` 函数、`evaluate.ts` 分支、`mount.ts` 全项、`memory-benchmark.ts` 分支、`plan.ts` / `render.ts` / `notify.ts` 分支。门槛语义已是 DSH 形，但数值仍是旧平均线，低洼不补则水位线无法上移。

## Decision

- 按 ROI 排序补测（纯函数/确定性分支优先，调度器接线随后）：tool 输出 render 全工具循环 + global update 审批分支；wrapup `onError`  containment；evaluate 解密失败/dev-key 回退/executor-reviewer 停止与空回退/JSON 文本回退/证据截断/无路由与无服务 fail-loud/归一化缺省；mount loader 接线三态 + `restoreMounted` 四态 + 腐败 ledger；plan 截断命名与非对象拒绝（新 `test/plan.test.ts`）；render skill 合约/折叠计数/引用后缀（新 `test/render.test.ts`）；notify 溢出计数/declined 域/无标题回退/未知 kind/非 Error  containment + `buildMemoryReceipt` 重复 `??` 合并（行为不变的简化重构，消灭两处死分支）；memory-benchmark update/delete 全分支。
- 水位线棘轮上移：lines/statements 78→82、functions 65→89、branches 65→73（当前真实最低线：`skillquality` 82.81 / `fate` 90 / `auto` 73.36）。
- 留在路线图：`auto.ts`（89/73，调度器接线体量大）、`command.ts`、`fate.ts` `onError` 防御单行（与已钉死的 wrapup 同形）、逐文件 100 与未覆盖定位器。

## Alternatives considered

- **一步到位逐文件 100**：`auto`/`command` 需大量调度器脚手架，且易写出凑数断言；分轮棘轮更诚实。落败。
- **降低水位线迁就低洼**：与 DSH 方向相反；低洼多为高价值行为分支，补测本身就是回归资产。落败。
- **为凑数覆盖 `fate.ts onError`**：触发需破坏 engine 目录中途状态，测试脆弱且只钉防御单行；同形已由 wrapup 覆盖。落败。

## Consequences

- 收益：845 测试 / 50 文件（+50 测试，+2 文件）；`tool` / `notify` / `mount` / `evaluate` 四个文件语句与函数 100；全仓 94.12 / 83.71 分支 / 98.53 函数。
- 代价：`branches: 73` 仍远低于 DSH 的 100；`auto.ts` 是下一轮主战场。

## Testing

- 新增/扩展 7 个测试文件用例；`pnpm test` 845 全绿；per-file 水位线 `pnpm test:coverage` 全绿；tsc（含 scripts）/oxlint/TS 四门禁全绿。
