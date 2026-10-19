# Agent Note: task-fitness-for-memory-skill-rsi

Status: proposed

> 放置路径：本文件（`.agents/notes/proposed/testing/2026-10-18-task-fitness-for-memory-skill-rsi.md`）。
> 2026-10-18 用户提出「想做记忆/技能的 RSI，但发现知识匮乏、做的东西很烂」，同日盘点 GitHub 生态后确认缺口在**任务级可执行验证器**，而非机制数量。执行入口见 [开发计划](../../../../docs/plans/2026-10-18-memory-skill-rsi-fitness.md)。

## Problem

插件的进化是机制驱动的：v0.17 事件驱动评审、v0.18 分层提级与 30 天实习、v0.19 注入账本与 token 预算三档，每条都有 ADR，**没有一条有"带来多少增益"的测量**。现有度量只有两个代理指标：

- `scripts/eval-recall.ts` 只测索引召回（`recall@1/3`），召回率高不等于任务结果好；
- 注入账本与近 7 天转化率只测 adoption（正文被取回的比例），不测任务成败。

后果是机制复杂度增长快于证据：无法判断哪条该留、哪条该删；也无法回答"记忆/技能是否真的让后续任务更好"这个项目的核心主张。研究界能跑通 RSI 的前提是可执行 fitness（DGM 之于 SWE-bench、AlphaEvolve 之于算法加速比），本项目缺的正是这一层。

## Proposal

建一条任务级 fitness 线，分四阶段落地（细则见计划文档）：

1. **P0** 冻结 20–30 条真实会话任务为私有回归集（`evals/tasks/*.yml`），判据优先级：可执行断言 > 结构化比对 > 人工 rubric > LLM judge；无判据的任务不入集。
2. **P1** `scripts/eval-tasks.ts` 跑单臂（`base`）并落 `report.json`，固定 schema 与可复现约定（同批两次 `acc` 必须一致，不一致标 `flaky` 先修判据）。
3. **P2** 四臂对照 `base` / `current` / `candidate` / `reflect`（定义照 GDPevo），出五指标（acc / rounds / tool_calls / cost / lift）+ 三项记忆专有指标（recall_hit / conflict_ok / repeat_err）对照表。
4. **P3** 接门禁：改动 `src/` 记忆/技能/注入模块的 diff 要求存在 `compare.md`，`run-gates` 只警告不失败；发版流程增加"附一次四臂结果"的人工项。

外部锚点（MemoryAgentBench AR/CR 子集、Workspace-Bench-Lite）每季度跑一次，只做漂移检查，不与自建集混算。

## Alternatives considered

- **直接用公开 benchmark 当 fitness**：分布不匹配。GDPevo 是 CRM/ERP/金融业务任务，Workspace-Bench 是大文件工作区，都测不到"个人记忆插件在跨会话偏好上的增益"。自建集不可外包。
- **只扩 `eval-recall.ts` 的召回指标**：召回是代理，注入位置或表述变差时召回率升高而任务结果可能变差。仅作辅助指标。
- **先上 GEPA/DSPy 自动优化注入指令**：没有任务级 metric 时优化器会把"更像训练集"当作改进，方向不可控。放到 P4，且产物先过 `candidate` 臂。
- **LLM 自评作为唯一 fitness**：可被 gaming，且与项目"模型提议、代码保证"的既有立场冲突。仅允许双 judge 一致时作辅助。
- **不建回归集，靠 `OBSERVATION.md` 人工观察**：无法证伪、无法进 CI，等于继续靠感觉。

## Consequences

+ 每条 memory/skill 机制改动第一次有了可对比的 lift 数字，取舍从观点变成证据。
+ 回归集与判据是本项目独有资产，外部 benchmark 无法替代；也构成"模型提议、代码保证"在结果层的延伸。
+ `flaky` 标记与季度替换 20% 的规则，把回归集腐化成本前置暴露。

− 新增一套评测工程：任务集维护、判据修复、跑批成本（每批 4 臂 × 20–30 任务）。
− 小样本（<20 任务）结论按噪声处理，短期可能给不出显著 lift，需要容忍"暂时看不出差别"。
− 判据只覆盖可判定任务，主观质量维度仍只能进 `OBSERVATION.md`，评测范围有天花板。
