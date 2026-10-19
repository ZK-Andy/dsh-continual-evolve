# 实施计划：架构功能性补充总纲（PilotDeck 借鉴 × 门禁缺口为骨架）

> 状态：**待实施**（2026-10-19 用户拍板：散待办整合为一份档案，以 PilotDeck 借鉴清单与门禁缺口三批为骨架，结合现有架构形成本计划）。
> 骨架来源：[PilotDeck 差距分析 §5](../research/pilotdeck-gap-analysis.md)（借鉴三类）+ [机械门禁缺口清单 §3](2026-10-19-mechanical-gates-backlog.md)（G1–G12 三批）。
> 关系：本文件是**唯一总入口与排序器**；子计划文档保留为各轨道的执行细节入口（见 §4），其内部顺序不变，由本计划统一调度。取代此前 13 条分散待办的记账。

## 0. 一句话

在不触动架构不变量的前提下，把「可观测粒度、误删保护、LLM 提案机械校验、评测闭环」四类功能性补充按依赖排序成 P1–P6 六个阶段，每阶段独立提交、带 ADR、全绿。

## 1. 架构锚点（本计划的硬边界）

一切阶段不得触碰 [architecture-standard.md](../architecture-standard.md) §4 三条不变量：**注入永不破坏组装**（任何失败降级空渲染）、**prompt 会话内字节稳定**（cache 契约）、**存储单写者**（模型意图一律提案 → 机械门禁 → 事务落盘）。分层语义门禁（R1–R4 显式边表）与模块预算（400 行 / 12 出度 / 80 函数）对每个新文件同样生效；**行为级变更必须同变更携带 ADR**，纯机械新增豁免。

PilotDeck 的任何借鉴均为**设计重写**（AGPL-3.0，代码不得进入本仓库）。

## 2. 已整合的路径决策

| # | 冲突 | 拍板 | 依据 |
|---|---|---|---|
| D1 | 召回度量 A/B 与 RSI P0–P2 都要建"带负例的自建评测集" | **合并**：统一住 `evals/`，一套 fixture、一套 runner、一套负例口径；`eval:recall` 降为检索层子项，QA/四臂为任务层 | 两套基建必然口径漂移；RSI 计划 §9 已认"召回仅作辅助指标" |
| D2 | PilotDeck「软删 + restore」与归档可见性 ADR 已否决的"恢复入口"冲突 | **按 ADR 立场**：不做独立恢复机制（恢复走账本快照，既有能力）；P4 做 `archive_reason` 时仅评估 `deleted_at` 语义，推翻需 ADR 修订 | `.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md` Alternatives 第 4 条 |
| D3 | PilotDeck「每轮检索」vs 本插件「会话冻结注入」 | **推迟决策**：P5 评测数据（召回/命中/成本）落地后再定；P6 仅做零风险的四段分层与冲突守则 | 架构级分叉，冻结注入绑 prompt cache 契约，无数据不动 |
| D4 | PilotDeck 借鉴散成 7 条独立待办 | **撤销条目**：出处按轨道并入本计划各阶段，调研文档保留为唯一出处库 | 借鉴条目本质是分发器，内容与他条重复 |
| D5 | 提取轨三笔账与 PilotDeck 提取轨借鉴同文件面 | **同批**：三笔账并入 P2（同为 `extraction-prompt.ts` / `memory-apply.ts` 面，一份 ADR 覆盖） | 避免同文件两轮迁移 |
| D6 | 零变化评审门槛 vs 门禁批次 A | **归 P1 评审轨**，与 G3 无文件冲突（评审调度 vs 门禁脚本） | — |

## 3. 阶段（P1–P6）

### P1 速赢批（约 1.5 天，行为变更一份 bug-fix ADR）

| 项 | 出处 | 验收 |
|---|---|---|
| 卡片读数拆「索引召回 N/M」+「正文取回 K」，样本 <10 不显示比率 | 召回度量方案 §C | 卡片双读数；`rate` 改名 `readThrough` |
| 评审队列加 `changed-since-last > 0` 硬门槛 + 锚点 reconcile（零变化不烧 LLM） | PilotDeck 借鉴 §5.1-5 | 零变化批次零调用并记账 |
| 解析容错：`parseExtractionAnswer` 清洗控制字符后重解析，仍失败保留原始答案落待重试 | 提取轨三笔账 | fixture：裸控制字符提案不再整批丢弃 |
| 提取正文去会话细节 + update 溯源列（拍板"刷新来源"或 provenance 历史列） | 提取轨三笔账 | `dislike-temporary-solutions` 类正文不再含事故叙述；update 行来源可溯 |

### P2 提取轨借鉴（2–3 天，feature ADR）

| 项 | 出处 | 验收 |
|---|---|---|
| 两段式提取：分类 prompt（Identity/Override/Output 三测试 + evidence 强制引用）→ 生成 prompt 消费分类结果 | PilotDeck §5.1-7（`llm-extraction.ts:218/:2552` 设计重写） | user/feedback 边界 fixture 各 ≥2 例；分类失败整批不写 |
| 被拒候选逐条记 reason（`invalid-schema`/`duplicate`/… 分布入账本） | PilotDeck §5.1-2 | `extraction_log` 可统计拒因分布；G3 红绿俱验覆盖新门禁 |
| 审计补 `prompt_json` 列（systemPrompt/userPrompt/rawResponse 可回放） | PilotDeck §5.2-4 | 抽查任一落盘行可复现当时调用 |

### P3 门禁三批（8.5 天，**执行细节走缺口清单 §3，本计划只定序**）

G3 红绿俱验 → G1 ADR 覆盖率 → G2 依赖环 → G4 预算棘轮 → G5 导出面快照 → G6 Schema/枚举快照 → G12 归层白名单 → G9 测试配对 → G7 历史词 → G8 Alternatives 质量 → G11 ast-grep → G10 变异抽样。

依赖提示：P2 的拒因枚举与 P4 的 `archive_reason` 枚举**必须先过 G6 快照**再合并（先做 G6 相关项或与其同批）；G3 是 P2/P4 新门禁可信的前提。

### P4 记忆生命周期（2–3 天）

| 项 | 出处 | 验收 |
|---|---|---|
| `archive_reason` 四值列 + 一次性回填 + 卡片只读「已归档」区 | 归档可见性 ADR（执行入口不变） | 四类原因各一测试；卡片上限 50 条无操作按钮 |
| 同源去重：提取落盘挂 `sourceSessionKey`，同会话同主题 upsert 而非新增 | PilotDeck §5.2-3 | 同会话重复提案只产生一行 |
| 条件删除：新内容 body 实质变化才删源，LLM 失败绝不删 | PilotDeck §5.2-2 | 失败路径零删除；diff 为空不删 |
| staged 回滚评估：提级/批量合并是否需要 before/after 快照 + hash 校验回滚（做则同批 ADR，D2 已定不做 UI 恢复） | PilotDeck §5.2-1 | 评估结论落 ADR（做/不做皆可，不许悬置） |

### P5 评测基建统一（5–7 天，执行细节走 RSI 计划 §5，口径按 D1 修订）

RSI P0–P3 照原计划推进，但 fixture/负例/runner 统一：P0 的回归集同时承载召回 A 的"每类记忆 + 负例 + 逐条覆盖"（`eval:recall` 进 CI 即召回退化红）；P2 的四臂报告含 `recall_hit`（读注入账本）；QA 题集即召回 B。P4 季度外锚不变。RSI 计划 §5 需加一行 D1 修订注记。

### P6 注入演进（0.5 天 + 一个决策门）

| 项 | 出处 | 说明 |
|---|---|---|
| 注入四段分层（User Profile / Project / Feedback）+「与本轮指令冲突以本轮为准」守则 | PilotDeck §5.1-4 | 提示词两行，注意会话内字节稳定：分层属构建期内容，冻结机制不变 |
| post-compact 重注入评估：compaction 后记忆接回上下文 | PilotDeck §5.2-5 | 与宿主 compaction hook 能力对齐后评估 |
| **决策门**：每轮检索 vs 会话冻结（D3） | PilotDeck §5.2-6 | 依据 P5 的召回/成本数字拍板，倾向不动 |

## 4. 与既有文档的关系

| 文档 | 角色 |
|---|---|
| 本计划 | 唯一总入口与排序器 |
| [门禁缺口清单](2026-10-19-mechanical-gates-backlog.md) §3 | P3 的执行细节（G1–G12 断言与验收原文） |
| [RSI fitness 计划](2026-10-18-memory-skill-rsi-fitness.md) §5 | P5 的执行细节（P0–P3 验收命令） |
| [召回度量 ADR](../../.agents/notes/proposed/architecture/2026-10-18-memory-recall-metrics.md) | P1-C 与 P5 口径的决策依据（A/B 并入见 D1） |
| [归档可见性 ADR](../../.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md) | P4 执行入口（软删立场见 D2） |
| [PilotDeck 差距分析](../research/pilotdeck-gap-analysis.md) | 借鉴项唯一出处库（文件:行号全在 §5） |

## 5. 排序理由与总成本

依赖链：P3-G3（门禁自身可信）→ P2（新账本/新枚举要被门禁覆盖）→ P4（schema 变更先过 G6 快照）→ P5（用评测闭环验收前面所有改动）→ P6（注入决策依赖 P5 数据）。P1 不依赖任何阶段、成本最低收益立即，先做。

总预算约 **20–24 人日**（P1 1.5 + P2 2.5 + P3 8.5 + P4 2.5 + P5 6 + P6 0.5，含缓冲）。每阶段独立提交、独立验收，可随时在阶段边界停下，不存在跨阶段半成品。

## 6. Alternatives considered

- **13 条待办各自推进、不建总纲**：每条只写"触发条件"，无人负责跨条目排序与依赖（G6 先于枚举变更这类约束无处安放）；PilotDeck 条目与其他条目各执一词（软删冲突实证）。落败：整合正是本次动机。
- **按来源项目分批（PilotDeck 批 / 门禁批 / 召回批）**：来源不是架构关心的维度，同文件面的活会被拆到两批（提取三笔账与两段式）。落败：按轨道与依赖排序，出处只作引用。
- **立即评估每轮检索**：牵动 prompt cache 契约（不变量 2），且无自家召回数据支撑判断。落败：D3 推迟至 P5 后。
- **把 PilotDeck 六条立项项全部纳入本计划**：其中软删（D2）与每轮检索（D3）已有立场/已推迟，另四条（staged 回滚、同源去重、条件删除、promptDebug）已分别归位 P2/P4，无需独立"立项池"。落败：避免第二本账。
- **合并 RSI 与门禁为一个超级批次**：两者改动面零重叠（evals/ vs scripts/），并行不互锁，合并只会推迟门禁收益。落败：保持 P3/P5 两轨。

## 7. 开工检查单

1. `pnpm typecheck && pnpm lint && pnpm test` 基线绿（当前 700 测试 / 55 文件）；
2. 每阶段开工前复核 §2 决策表是否仍与既有 ADR 一致，有分歧先改 ADR 再动工；
3. 行为变更同变更携带 ADR；P2/P4 新枚举先确认 G6 覆盖；
4. 阶段收尾：独立提交 + 本计划 §3 表格该行勾账（移入已完成指针），HANDOFF 滚动窗记一行。
