# Agent Note: 内容质量自进化环——模型评审自动改写

Status: implemented

> 放置路径：`.agents/notes/implemented/architecture/2026-10-12-content-quality-evolution.md`
> 前序：`.agents/notes/implemented/feature/2026-10-11-skill-wiring-s1.md`（S1 地基）；`.agents/notes/implemented/architecture/2026-10-12-skill-usage-loop-v2.md`（V2 只计翻不判好，保留做存在心跳）；`.agents/notes/archived/architecture/2026-10-12-review-loop-retrieval.md`（评审运行指标方向已废除）；`9935876` 预留（`corrects` 列 + `item-review` 账本位）。

## Problem

S1 建好了存与看，V2 补了翻的计数，但“写得好不好”仍无人回答：使用回路数的是查阅次数（标题党也会高，零查阅也可能只是没到场景，且宿主 loader 直读记不到，下界失真）；已废除的评审数的是运行指标（判了多少条、花了多少 token），不是沉淀内容本身。用户目标是自动自进化、零人工干预：库里的记忆条（title/description/body + type）与技能条（description 路由 hint + 正文）要自己变好，不用人点按钮、不出报告等人看。同时频率可控（自进化日耗远低于对话 1/10），存量历史一次性消化，之后永不再欠账，且全程留数可复盘（用了几次、进化几次、硬顶丢了多少）。

## Decision

一条与提取轨并行、不共享游标与提示词的独立评审进化轨（`src/review.ts` + `src/review-prompt.ts` + `src/token-usage.ts`）。模型提议、代码保证：评审打分与改写提案走模型，是否落盘走代码硬门禁，落盘后账本可回滚，全程无人。

- **评审对象**：全部 active 记忆条与技能条。记忆判 5 维（准确、可用、可复用、不重复、不过时）；技能判 4 维（description 触发精度、正文可执行完备、可复用、不重复）。输出一律结构化 JSON（`verdict: keep/rewrite/quarantine` + `reason` + 改写提案），禁 delete verdict。
- **两段调用**：便宜门先行（`值得细看吗`，false 只记 skip 不进贵的；true 才进贵的改写调用）。评审自带便宜门（与提案“共用提取判定”不同——提取判定读的是轨迹增量，评审判的是条目文本，输入不同无法共用；共享的是思想不是调用）。存量与回炉拼批（batchSize 默认 10）。
- **三触发全自动**：全局单飞 + 5 分钟最小间隔；turn 边界 arm 待审工作区，compaction 与会话收尾 drain。新写经候选队列自然优先（priority 0），存量一次性基线排空（`corrects` 指到的 priority 1 连带复审），30 天未动回炉（priority 2，判完再冻 30 天）。旧条默认永不复审。
- **双保险自动线**：verdict 无 delete，隔离经 `store.quarantine` 软隔离（注入与列表隐藏，按 id 可查，账本可恢复，物理删除永不自动）；单条单次正文长度变化超 30% 强制转隔离（`rewriteMagnitude`，防发散）。
- **硬顶 100 条/天**：`review_daily` 原子消费（`reviewed < budget` 才 +1，否则 -1），优先级新写 > 被纠正牵连 > 陈旧 > 抽查，超顶尾部记 `budget-exhausted` skip 行并计 dropped，不滚雪球。
- **统计四块**：①用量：`skill_usage` 沿用，新增 `memory_usage`（`memory_read` 按 id 取正文 +1，检索/列表不记）；②进化史：`review_log` 行（item/verdict/reason/cheap_usage/evolve_usage/applied/evolve_count）+ `corrects` 链，随账本轮转；③日 rollup `review_daily` 一天一行（预算/实审/新写/回炉/批了/落盘/cheap_token/evolve_token/积压/丢弃/skip_top + skip_counts 累计）；④token 记账复用 `normalizeUsage` 归一并按 cheap/evolve 分账。
- **试运行默认开**：`review.dryRun` 默认 true——verdict 落账，改写与隔离都不落盘；分布看顺后关掉才自动落盘。

## Alternatives considered

- **Hermes 式 GEPA 离线进化**：考题→行为分→Pareto 变异，一次 $2–10，Phase 2–5 未落地且变更走 PR 必人工。与零人工目标冲突，且记忆条不好出“考题”（不像技能能做题）。落败，只借“行为分+文字反馈”思想。
- **prime-agent 全套 refine**：五类状态+双库版本史+四态调度+20 分钟冷却+子代理并行 review-sweep。是给多人长会话 RLM 做的重机制，与 10-04“机制要少”结论冲突，单人小库用不上分支防 stale 与 8 并发。落败，只借“review gate 两段+scope 纪律”。
- **人审报告线**：评审只出报告、改写等人点。Hermes 与 prime 实际都落在这里，但用户明确零人工。落败。
- **每天全库重打分**：存量每天重审，保证无漏。token 与库总量成正比，用越久越贵，必积压。落败，改存量一次+增量永续。
- **搭提取顺风车（老管线内判）**：在提取那次 LLM 里顺手评审。用户已禁新设计走老管线，且提取的闭集提案与评审的改写提案语义不同，混管线互相污染。落败，独立成轨。

## Consequences

- 内容可观测：每条终态一行 `item-review` verdict，日耗一行 rollup；试运行期先看分布再开自动。
- 代价：`review_log` 明细（随账本轮转）+ `review_daily` 一天一行（永久）；每次 drain 最多一批 LLM 调用（batchSize 上限）。
- 诚实边界：用量是存在心跳下界（宿主直读记不到）；评审判的是文本质量不是行为效果（无任务考题）；隔离行按 id 仍可读（与技能隔离行为一致）。
- 验证：295 测试（含 26 个新增评审回归：用量/账本/预算/verdict/护栏/调度外只测纯部）/ typecheck / lint / 文档门禁全绿；双语 README 与设计同步。

## Testing

- `test/review-store.test.ts`（用量计数、verdict 落账与轮转、日预算原子消费与累计合并）。
- `test/review.test.ts`（候选三优先级、no-route/门拒/keep/改写落盘/试运行不落/超幅转隔离/隔离软删/解析失败降级/硬顶丢弃）。
- `test/review-prompt.test.ts`（门与改写解析：裸/围栏 JSON、非法 verdict、字段截断、邻居携带）。
- `test/token-usage.test.ts`（归一 20 余种实测形状、非法输入 null、纯累加；自 `bb35faa^` 恢复）。
