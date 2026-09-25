# Agent Note: 覆盖率第六轮（validate + wrapup-command）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-validate-wrapup-round-6.md`

## Problem

第五轮后 `validate.ts`（语句 91.24）是语句最低线，`wrapup-command.ts`（分支 75.6）是分支最低线。前者缺 update-only 路径（无类型更新的类型归一、update 携带 reference 的完整合约、legacy 拼写、update 携带 content）；后者缺 ghost 键全系、ask 抛错/畸形、approval 非 Error 抛错。

## Decision

- validate +7 例：无类型更新四形状（before 缺席/空/有他键/有 feedback 型，行为全钉死）、update 携带完整合约引用、legacy `python_import`/`call_pattern` 拼写、无 import 引用拒绝、update 携带好/坏 content。语句 91.24→99.3、分支→~97。
- wrapup-command +7 例：onError 补 string 调用（与 Error 臂对偶）、ghost promote/split/archive/keep 四形态静默处理、covered 跳过行、approval 问询抛 string 直达 `String(cause)` 臂、archive 问询抛错与畸形回答。语句 94.36→100、分支 75.6→90.9。
- 无源码改动（纯加测；两处候选删除均因类型收窄需要而保留，见备选）。
- 仍 decline（有证明）：validate 有效类型三元的 `: undefined` else 臂（create 必带有效类型或早退、update 必走前两臂、其余动作到不了）与两处 `?? ""`（create 缺 content 死于 L78、update 缺 content 跳过 L113）；wrapup `?? candidate.id` 双处（service 无 applied:false）、`?.title ?? item.key`（promoteItems 蕴含候选存在）、`!candidate` 三处与 `!item.promote` 一处（类型收窄必需，输入端已过滤）、`!proposal`（keep+contradicted 蕴含定义）。
- 水位线本轮不动（91/91/91/75）：语句最低线移至 service 91.72，未过整数关——棘轮保持"永远绿、只上移"，不硬凑。
- 双语 README 测试数 932→943；覆盖率整数徽章不变（97/87/99）。

## Alternatives considered

- **删 wrapup 类型收窄守卫（L139/L152/L166）**：守卫确死，但删除后 `candidate.kind` / `splitPromoteProposals(item…)` 失窄致 tsc 报错；为消分支数而重构生产代码形状属本末倒置。落败，记为 typed-dead。
- **为 L109-else / `??` 写 mock 硬凑**：else 臂在类型层面不可达（上附证明），mock 只能伪造调用方违背契约的输入，测的是 mock。落败。
- **水位线象征性 +1 到 92**：service 91.72 不满足 92，门禁会红；整数关不过就不动。落败。

## Consequences

- 收益：943 测试（+11）；`wrapup-command` 语句 100；全仓 97.76 / 87.96 / 99.51；三项 100 文件 9 个（validate 差 1 语句 2 分支、wrapup 差 7 分支，均为已裁定项）。
- 代价：分支 87 距 DSH 100 仍远；下一最低线 service（91.72）与 wrapup-command 分支（75.6）。
- 后续：第七轮主战场 `service`（91.72）；`../` 前缀口径仍待产品拍板。

## Testing

- `pnpm test` 943 全绿；per-file 水位线 `pnpm test:coverage` 全绿（91/91/91/75 原线）；tsc（含 scripts）/oxlint/TS 四门禁全绿。
