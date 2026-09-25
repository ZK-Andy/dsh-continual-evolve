# Agent Note: 覆盖率第四轮（review-scheduler 出坑 + onError 三连胜 + 定位器）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-scheduler-onerror-locator.md`

## Problem

第三轮后 `review-scheduler.ts`（语句 86.58 / 分支 79.16 / 函数 93.75）接棒最低线；`fate`/`command`/`auto` 各剩 `onError` 防御单行（第一、二轮以"需破坏 FS、测试脆弱"为由 decline）；"逐文件 100 与定位器"中定位器一直缺位——找未覆盖行靠手工翻 JSON。

## Decision

- `review-scheduler` +13 例：compareReviewCursors 全分支单元测试；execute 抛错 containment；stale 快照跳过；shutdown 后 schedule 无操作 + 双 shutdown；18 连发 burst 上限；rejected pending 剪枝；高边界替换；unsettled 等待；首 acquisition 等待中 abort；pending 等待中 shutdown。语句 86.58→100、分支→95.3、函数→100。
- 删两处经证明的死代码（行为不变，第一轮 `??` 合并先例）：① scheduler `bestIndex < 0` 回退——L86 错误清除后 settled 全为 acquired（SnapshotAcquisition 恰为二变体），首个 settled 必占位；② fate approved 分支的 turn-notify——consent approved 仅来自 goal_blocked consult（L350），reason 恒为 goal_blocked，turn 条件永假（收紧引入的残留，live notify 在 silent 路径 L427 不受影响）。
- onError 改判：第一、二轮 decline 的理由是"触发需破坏 FS"，本轮找到非脆弱缝隙——回调对象经邻居模块 mock 捕获后直接调用（真实接线、只注入失败），确定性、无时序。`fate`（assess mock，附带钉死 assessed 审计行）、`command plan`（planner mock）、`auto memory`（memory-agent mock）三则落地；三文件函数 100（fate 90→100、command 95.23→100、auto 91.3→95.65）。
- 仍 decline（有证明，非凑数）：`command forget vanished`（单线程无确定缝隙的竞态分支）、两处 `engine.load("project")` catch（`loadHarnessState` 承诺坏文件永不抛、`storePaths` 不抛）、三处 `pruneJsonlFile` catch（被调函数内部全 try 包裹、自身不可能抛）、`auto review` onError（`runReviewPhase` 未导出，需全门禁驱动，成本与一行 warn 不成比例，同形已钉死三处）。
- 定位器 `scripts/coverage-gaps.ts`（`--self-test` 自检、tsx 直跑、含于 `tsconfig.scripts.json` typecheck）：跑一次全量 JSON 覆盖，按未覆盖语句数排序输出文件×行区间×源码摘录＋分支/函数缺口；`package.json` 新增 `coverage:gaps`，双语 README 开发节各加一行。
- 水位线棘轮：86/90/86/75 → 90/91/90/75（新最低线 benchmark-command 语句 90.06、wrapup-command 分支 75.6、logfile 函数 91.66）；双语 README 徽章 870/96/85/98 → 913/97/86/99。

## Alternatives considered

- **为 `vanished`/project-catch/prune-catch 写 mock 硬凑**：mock 被调函数本身抛错测的是 mock 而非接线（prune 真身永不抛），属凑数断言；`vanished` 需跨 await 并发变异，无确定缝隙。落败。
- **保留两处死代码**：`bestIndex` 回退与 approved-turn-notify 均有构造性不可达证明，保留只压水位并误导读者。落败。
- **定位器做成覆盖率门禁的一部分**：定位器是只读开发工具，进门禁即 manufacture 紧张；水位线门禁保持唯一数值闸。落败。
- **一步把分支水位提到 80**：最低线 wrapup-command 75.6 与 benchmark-command 75.62 仍远，一步提会红；棘轮保持"永远绿、只上移"。落败。

## Consequences

- 收益：913 测试（+19）/ 53 文件；全仓 97.06 / 86.36 / 99.51；`review-scheduler`、`fate`、`skill-render` 三项 100 文件达 7 个；`coverage:gaps` 终结手工翻 JSON。
- 代价：分支 86 距 DSH 100 仍远；下一最低线 benchmark-command（90.06，大量错误分支 `not found` 类，可走现有 harness 补）与 wrapup-command 分支（75.6）。
- 后续：benchmark-command 错误分支是第五轮主战场；`../` 前缀口径（第三轮记账）仍待产品拍板。
- 观测：v8 分支数连续跑之间有 ±0.2 抖动（skillquality 82.67/82.81），整数水位线不受影响。

## Testing

- `pnpm test` 913 全绿；per-file 水位线 `pnpm test:coverage` 全绿（含新 90/91 线）；tsc（含 scripts）/oxlint/TS 四门禁全绿；`coverage-gaps --self-test` 通过。
- scheduler 死代码删除后 18 例全绿；fate 死 notify 删除后 35 例全绿（含既有 turn-notify 用例，live 路径未动）。
