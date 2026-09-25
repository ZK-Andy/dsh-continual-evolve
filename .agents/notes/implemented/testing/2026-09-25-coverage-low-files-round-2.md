# Agent Note: 低洼文件覆盖率补齐第二轮（auto/command）与覆盖率徽章

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-low-files-round-2.md`

## Problem

第一轮（`2026-09-25-coverage-low-files-round-1.md`）后，`auto.ts`（89/73）与 `command.ts`（86/75）是最大的低洼；双语 README 只有测试数徽章，没有覆盖率徽章，覆盖率进展不可见。

## Decision

- `auto.ts` 89/73→98/82：drain 双模式 shutdown 抛错 containment、audit/armed 落盘失败 warn、全门 wiring 用例三则（skill  withheld + auto-case 落盘、skill 同意落地 + 前台通知、memory dedicated 落地 + 通知）。附带发现并钉死一个真实语义：`evolve_complete` 事件与审计行共用 `reviews.jsonl`，断言按 outcome 行过滤。
- `command.ts` 86/75→98/86：project 作用域三则（list 成功/无 cwd fail-loud/remember 落项目库）、consolidate 四则（空报告/过期报告与应用/merge 并入 survivor）、分发直通（wrapup/goal/mount/mount-list/unmount/benchmark）、project 感知 status 与 usage、空日志与非法 tail、import 脏 kind 容忍、remember/plan 跨会话审批；usage 溢出截断（16 注入 + 21 沉寂）。
- 双语 README 加三个静态覆盖率徽章（statements/branches/functions），与测试数徽章同行维护。
- 水位线棘轮上移：82/89/82/73 → 82/90/82/75（真实最低线：`skillquality` 语句 82.81 与分支 75、`fate` 函数 90）。
- 剩余缺口全部归入明确类别：不可达防御（prune catch、runGate 重入、forget 竞态消失）、需破坏 FS 的 onError 单行（`fate`/`command plan`/`auto memory`，同形已由 wrapup 钉死并经 tsx 直接探针验证触发条件）、engine.load 抛错 catch（`status`/`usage` project 分支）。

## Alternatives considered

- **为 `fate.ts onError` 写脆弱测试**：需在 gate 运行中途破坏 engine 目录，时序脆弱；第一轮已裁定落败，本轮维持。
- **动态徽章服务**：覆盖率来自本地 vitest，无外部服务可拉；静态徽章随版本提交更新，与测试数徽章同纪律。落败。
- **水位线一步提到 100**：`auto` 调度器与 `command` 分发仍有缺口，一步提会红；棘轮保持"永远绿、只上移"。落败。

## Consequences

- 收益：870 测试 / 50 文件；全仓 96 / 85.51 / 98.53；`command` / `auto` 进入 98 行列；双语 README 覆盖率可见。
- 代价：分支 85 距 DSH 100 仍远；`skillquality`（82/75）是下一轮最低线持有者。

## Testing

- `pnpm test` 870 全绿；per-file 水位线 `pnpm test:coverage` 全绿；tsc（含 scripts）/oxlint/TS 四门禁全绿。
