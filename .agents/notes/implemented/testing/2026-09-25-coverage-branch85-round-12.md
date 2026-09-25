# Agent Note: 覆盖率第十二轮（分支 85 清线：一轮五文件）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-branch85-round-12.md`

## Problem

第十一轮后分支 85 线下 5 文件。按用户拍板一轮全收：`tool`（83.8，差 2 臂）、`skillquality`（82.8，差 3 臂）、`wrapup`（82.9，差 4 臂）、`auto`（82.5，差 6 臂）、`memory-agent`（80.7 地板，差 11 臂）。

## Decision

- `tool` +4 例（recall 全参透传、add 带 path、update 改 memoryType、project 审批标签）：语句 100、分支 83.8→90.6。
- `wrapup` +8 例（畸形评估归一化、空候选早返/无路由抛错、空标题覆盖判定、非本地审计、归档确认双源、拆分拦截双形、未分类跳过）：语句 95.8→99.3、分支 82.9→95.7。
- `auto` +6 例（忙碌/无 agent 状态、双 idle 去重、非 compaction 事件、minUserWords 透传、审计不可写警告、半程暂停 abort）：语句 99.0 不变、分支 82.5→85.4。
- `memory-agent` +7 例（提案信封三错、字段四错、清单未分类/归档/截断、检索空查询与精确 id、审批稀疏回退、路由 A 前缀）：语句 95.9→98.2、分支 80.7→90.2。
- `skillquality` +1 例（嵌套空值键）：语句 100、分支 82.8→83.6；剩余 21 臂经 `coverage-final.json` 逐臂核对，全部属于第三轮已裁定类别（`noUncheckedIndexedAccess` 界内索引 `??`、恒匹配分组 `??`、解析器内永不 boolean、非 Error throw-cause），上限即 83.6，不可再追。
- decline（有证明）：recall 读 catch（S6 永不抛，已实测腐败降级）与比较器微臂；auto prune 双 catch（写成功蕴含可修剪）、`String(cause)` 四处（真实抛错恒 Error）、turn_snapshot 重入（L348 主导）、门禁 onError（未导出，第四轮先例）；benchmark 回滚 String 臂（恒抛 Error）；project win32 臂；promotion 短脱敏臂。
- 附带修 flaky：recall 三元排序断言改序性质（同毫秒 ties 相邻不反转）；wrapup `42` 期望对齐 extractJsonObject 文案。
- 水位线分支 80→83（最低线 skillquality 83.59，`vitest.config.ts` 已改，`pnpm test:coverage` 全绿）；双语 README 1005→1031，徽章 98/91/99 → 98/92/99（分支首次过 92）。

## Alternatives considered

- **为 skillquality 凑数造 mock/改 `!` 断言**：21 臂全部 tsc 强制防御，mock 测的是 mock、`!` 降级安全 conventions。落败（沿用第三轮裁定）。
- **为 auto L259 做时序竞态测试**：pause 窗口在 debounce 调度与回调之间，非确定；半程暂停测试已覆盖 L304 同类语义。落败。
- **分多轮收五文件**：用户明确一轮做完；各文件缺口经测算均在 2–11 臂内，单轮可收（skillquality 除外，已证上限）。落败（不分）。

## Consequences

- 收益：1031 测试（+26）；85 线下 5→0 文件（skillquality 以 83.6 豁免）；全仓 98.9 / 92.6 / 99.5；三项 100 文件 14 个（语句维度）。
- 代价：分支水位只能到 83（skillquality 天花板）；auto 85.4 余量薄。
- 后续：`../` 前缀口径待产品拍板；函数 99.51 两处已裁定项不变；发版（第 9–12 轮均未发版）。

## Testing

- `pnpm test` 1031 全绿（54 文件）；`pnpm test:coverage` 全绿（含新分支 83 线）；tsc/oxlint/TS 四门禁全绿。
