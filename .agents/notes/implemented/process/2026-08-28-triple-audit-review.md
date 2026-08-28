# Agent Note: 三重审计轮（code-review × find-simplifications × archive-agent-notes）

Status: implemented

## Problem

#17 补强批次（2026-08-28 五个功能提交）加一轮全仓审计是 dotnet-deepseek-harness-desktop 仓 feature-flow 步骤 5 定义的评审纪律：「重大变更或用户指令的批量形态——对指定提交范围做事后审核」，以**三路并行 subagent** 独立执行（各带全量技能指令与仓库约定，不共享中间态），主会话汇总裁定。本项目从未跑过该协议的全仓形态。

## Decision

2026-08-28 对整仓（44 src 模块 / 36 测试文件 / 12 ADR）执行三路并行审计，汇总裁定如下（全部已随本变更落地）：

**采纳——正确性/安全 Blocker**（code-review 路）：
- **B1 引擎并发守卫死代码**：service.apply 把 planning 前的同一 state 对象同时当 working state 与 baseline，乐观并发比对恒等、广告的"多会话安全"不可达，陈旧副本整文件覆盖静默丢并发写。修复：working state 一律盘上重读，baselineState 仅作比对基准；补引擎级并发拒绝测试。
- **B2 secret 守卫旁路**：筛查面缺 reference/arguments/metadata，而 mount 把 reference 逐字写进生成的插件文件。修复：三汇入口（引擎咽喉/mount/晋升路径）筛查面扩至全部可植入字段。
- **B3+B5 update 校验矛盾**：validate 对 update 强制全量 skill 契约与双全 title/content，导致 skill 的 archive/demote/consolidate 全部失败、evolve_update 按自身描述必失败。修复：update 改为部分更新契约（apply 本就 `?? before` 合并），skill_kind 列为 update 不可变字段（回滚逆编辑携带持久值可过）。
- **B4 回滚丢 skill_kind**：guidance 技能删除后不可回滚恢复。修复：inverseEdit 携带 `before.skill_kind`。

**采纳——Suggestion**：S1 未知 kind 逐条失败（不再 TypeError 整提案）；S2 consolidate 合并目标互斥（幸存者剔出同批归档集）；S3 门禁重入锁（GateState.running）；S4 benchmark 输出 totalDurationMs 泄漏（FAQ #11 残留）；S5 快照/export 0600；S6 refinements 形状校验（坏文件永不 throw）；S7 merged 视图前缀在 update/delete 对偶剥离；S8 死导出删除。

**采纳——简化**（find-simplifications 路）：`removeBenchmark`/`listCaseMetas`/`isCaseFrozen`/`globalStateDir`/`localStateDir`/`ENTRY_KEYS`/`advanceGateState`/`zeroUsageEntries`/`baselineOf` 死代码删除（含各自测试）；`goalDrivesRounds`/`entryChangedSince`/`collectFailureSummary` 折叠为单一真相；**双分词器合并**（R2 ADR 点名的"简化审查时机"）：`normalizedTokens` 内部改用 search.ts `tokenize`，0.6/0.8 阈值重钉零漂移。

**采纳——ADR 语料**（archive-agent-notes 路）：归档 2 份（repo-hygiene-cleanup、skill-kind-persistence → archived/，Status 下插 Archived: 2026-08-28，正文零编辑，零 inbound 修复）；修正 3 处事实漂移（auto-case 的 remove 命令引用、R2 的双轨分词器行、FAQ #5 的 advanceGateState 表述）；补 secret↔sediment 交叉链接；模板双语声明与 notes/README 对齐。其余 10 份判定保留（安全规则/持久语义/所有权边界/重新引入条件类）。

**拒绝**（防重蹈）：recentUserText 折叠（duck-type 最小 shape 是 FAQ #1 纪律）；EVOLUTION_SERVICE 收缩（公共 npm API 面）；filterPromotable 五段守卫折叠（守卫对称性受 ADR 保护）；全部引库建议（零依赖是记录过的决策）。

## Alternatives considered

- **逐路串行审计**：省并发成本但违背协议本意——三视角独立结论才能交叉验证（本轮 B1/B5 与简化路的 baselineOf/entryChangedSince 发现在汇总裁定中合并为一组修复，正是并行化的收益）。
- **发现即改、多提交分散收口**：协议要求「修复一次性收口为单个 refactor(review) 提交」——逐条提交会让审计轮与功能轮的边界在历史里模糊。
- **B3 修复走"补全 title/content"方向**（调用方补字段而非校验放开）：archive/demote/consolidate/evolve_update 四个调用方都要改，且与 apply 已有的 `?? before` 合并语义冲突；放开校验是改动面最小、与实现早已对齐的方向。
- **auto-case ADR 的 remove 漂移走"补命令"方向**：命令面属功能决策不归审计轮；删死函数 + 修 ADR 是本轮正确动作。

## Consequences

- 引擎的乐观并发承诺首次真实生效：调用方批量内对同一 entry 的多次写入需保持互斥（现有 wrapup/fate/consolidate 均已满足）。
- update 语义变为部分更新契约——evolve_update 工具描述与实现首次一致；skill_kind 换形必须走 delete+recreate。
- 死代码净减约 130 行（含测试）；分词定义单一真相源在 search.ts。
- ADR 语料 12→10 份 active；archived/ 首次启用。

## Testing

- 引擎级新增：并发拒绝（陈旧 baseline 不覆盖并发写）、structured 字段 secret 旁路、skill metadata-only 归档、skill_kind 拒换/回滚恢复、merged-view update 前缀剥离。
- 全套 573 测试绿；三文档门禁绿（archived/ 被 verify-adr-format 豁免）。

## Related

- 三重审核协议出处：dotnet-deepseek-harness-desktop 仓 `.agents/workflows/feature-flow.md` 步骤 5（仓外文件，不设仓内链接）。
- [write-time-conflict-guard](../feature/2026-08-24-write-time-conflict-guard.md)：B1 修复的咽喉所在；其分词器双轨行由本轮兑现合并。
- [auto-case-capture](../feature/2026-08-28-auto-case-capture.md)：remove 漂移修正的归属。
