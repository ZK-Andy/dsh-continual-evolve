# 实施计划：架构功能性补充总纲（PilotDeck 借鉴 × 门禁缺口为骨架）

> 状态：**待实施 v4**（2026-10-19；三审架构接地之后，四审按源码逐条核验——#1 client 真消费者、#2 排序真在家 `resource-kinds.ts`、#3 D9 改认 update 语义变更+版本链指针、#4 P1 默认不刷新、#5 同主题判定进 P4 ADR、#6 caseTrace 同 D8、#7 P5a/P5b 拆分。修订口径见 §2 D9/D11 与各阶段注记）。
> 骨架来源：[PilotDeck 差距分析 §5](../research/pilotdeck-gap-analysis.md)（借鉴三类）+ [机械门禁缺口清单 §3](2026-10-19-mechanical-gates-backlog.md)（G1–G12，批次命名以本计划 §3 的 G-batch1/2/3 为准）。
> 关系：本文件是**唯一总入口与排序器**；子计划文档保留为各轨道的执行细节入口（见 §4），其内部顺序不变，由本计划统一调度。取代此前 13 条分散待办的记账。

## 0. 一句话

在不触动架构不变量的前提下，把「可观测粒度、误删保护、LLM 提案机械校验、评测闭环」四类功能性补充按依赖排序成 P0–P6 七个阶段，每阶段独立提交、带 ADR、全绿。

## 1. 架构锚点（本计划的硬边界）

一切阶段不得触碰 [architecture-standard.md](../architecture-standard.md) §4 三条不变量：**注入永不破坏组装**（任何失败降级空渲染）、**prompt 会话内字节稳定**（cache 契约）、**存储单写者**（模型意图一律提案 → 机械门禁 → 事务落盘）。分层语义门禁（R1–R4 显式边表，R5 client 单函数预算由 `verify-src-budgets` 拥有）与模块预算（单文件 400 行 / 出度 12、组装根 14 / 单函数 80 行，src 软、client 硬）对每个新文件同样生效；**行为级变更必须同变更携带 ADR**，纯机械新增豁免。新分层目录的允许集（G12 的 `layers.json`）初始值从标准 §1 分层推导（`data/` / `services/` / `surfaces/` / `pages/` + 根装配四文件），不是凭空建。

PilotDeck 的任何借鉴均为**设计重写**（AGPL-3.0，代码不得进入本仓库；施工纪律见 §7）。

## 2. 已整合的路径决策

| # | 冲突 | 拍板 | 依据 |
|---|---|---|---|
| D1 | 召回度量 A/B 与 RSI P0–P2 都要建"带负例的自建评测集" | **合并**：统一住 `evals/`，一套 fixture、一套 runner、一套负例口径；`eval:recall` 降为检索层子项，QA/四臂为任务层 | 两套基建必然口径漂移；RSI 计划 §9 已认"召回仅作辅助指标" |
| D2 | PilotDeck「软删 + restore」与归档可见性 ADR 已否决的"恢复入口"冲突 | **按 ADR 立场**：不做独立恢复机制（恢复走账本快照，既有能力）；P4 做 `archive_reason` 时仅评估 `deleted_at` 语义，推翻需 ADR 修订 | `.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md` Alternatives 第 4 条 |
| D3 | PilotDeck「每轮检索」vs 本插件「会话冻结注入」 | **推迟决策**：P5 评测数据（召回/命中/成本）落地后再定；P6 仅做零风险的四段分层与冲突守则 | 架构级分叉，冻结注入绑 prompt cache 契约，无数据不动 |
| D4 | PilotDeck 借鉴散成 7 条独立待办 | **撤销条目**：出处按轨道并入本计划各阶段，调研文档保留为唯一出处库 | 借鉴条目本质是分发器，内容与他条重复 |
| D5 | 提取轨三笔账与 PilotDeck 提取轨借鉴同文件面 | **同批**：三笔账并入 P2（同为 `extraction-prompt.ts` / `memory-apply.ts` 面，一份 ADR 覆盖） | 避免同文件两轮迁移 |
| D6 | 零变化评审门槛 vs 门禁批次 | **归 P1 评审轨**，与 G3 无文件冲突（评审调度 vs 门禁脚本） | — |
| D7 | 零变化门槛（`changed-since-last > 0`）会误杀时钟档与抽样档 | **门槛只限事件档**：时钟档（`staleDays` 到期复审，如 2026-11-15 坏账自然复核）与抽样档豁免；写进 P1 验收 | v0.17 三档队列语义；时钟档存在的意义正是"无变化、到期也要看" |
| D8 | `prompt_json` 全量落库会撑爆中央共享单库 | **只存失败与抽样**（成功调用按固定采样率），单条截断上限，随四账本统一 30 天 retention 裁剪 | `~/.dsh/evolve/memory.db` 全工作区共享；既有裁剪纪律在 `src/services/retention.ts` |
| D9 | 同源去重「upsert 而非新增」与 update 现状语义相撞 | **承认这是 update 语义变更**：现状 `updateMemory`（`memory-apply.ts:224-243`）为覆盖式 UPDATE 且**不写** `source_session`/`source_seqs`，去重路径改版本行后，普通 update 须同语义、不得双轨；版本链指针：旧行归档（`archive_reason='merged-duplicate'`）并回链新行 id，回链字段与主键策略由 P4 ADR 定死（归档行与 active 行主键不冲突为验收） | 只约束去重路径会留下双语义；旧"覆盖污染来源"论证与现状代码矛盾（现状根本不写来源列），已撤回 |
| D10 | 统一 `evals/` 后阻塞语义与 judge 观打架（召回 A 进 CI 红 vs RSI P3 非阻塞；`acc` 两次一致 vs judge 波动） | **双 gate + 双 runner**：检索层 recall 退化进 CI 红；任务层 fitness 非阻塞 warning；确定性任务集执行 flaky 判定，judge 型 QA 单独 report、不进 flaky | 同一 runner 两种退出语义必然漂移 |
| D11 | 四臂/QA runner 在哪跑、用什么身份调模型 | **已拍板 A（2026-10-19 会话问答，记录见 P5a ADR 拍板记录节；P5b 工时待 P5a 实测后单独重估）**：宿主平面命令（走 `ctx.get("agentDefaultModel")` 既有 `llm-call` 路由，符合单写者与现有传输纪律）；B 落败（新增密钥保管与费用纪律）。任务臂与 judge 同一模型（用户真实配置）；judge 同一模型独立判两次、一致才算 | 独立 `tsx` 脚本拿不到宿主 ctx（`model-route.ts:28`）；`eval-recall.ts` 能跑只因纯离线（fixture + 本地检索，零 LLM 调用） |

## 3. 阶段（P0–P6）

### P0 门禁先行批（2.5 天）——G3 + G6 抽出先做

评审修正：P2/P4 的新枚举与新账本列必须先有可信门禁，故把 **G3 红绿俱验**（1.5 天，缺口清单 G3 原文）与 **G6 Schema/枚举快照**（1 天，G6 原文）从批次抽出先行。G6 基线快照建立后，P2 的拒因枚举、`prompt_json` 列与 P4 的 `archive_reason` 列都在快照比对下变更，漏迁移即红。

架构落点：G3/G6 为 `scripts/verify-*.ts` 新两件 + `run-gates.ts` 注册（docs 模式）；G6 快照源为 `src/data/schema.ts`（含 `review-accounts.ts` verdict 八值白名单）与迁移链 `src/data/migrate.ts`（`ensure*` 幂等风格）；`layers.json` / `baseline.json` / `test-exempt.json` / `snapshot/` 现均不存在，P3 落地时一次建齐。

### P1 速赢批（约 1.5 天，行为变更一份 bug-fix ADR）

| 项 | 出处 | 验收 |
|---|---|---|
| 卡片读数拆「索引召回 N/M」+「正文取回 K」，样本 <10 不显示比率 | 召回度量方案 §C | 卡片双读数；`rate` 改名 `readThrough` 的兼容方案按 §7.5 由 P1 ADR 二选一（同批改完 / 双字段过渡），调用方链见本阶段架构落点（与 §7.5 一致） |
| 评审队列加事件档 `changed-since-last > 0` 硬门槛（**时钟档与抽样档豁免**，D7） | PilotDeck 借鉴 §5.1-5 | 零变化的事件档批次零 LLM 调用并记账；时钟档/抽样档行为不变（坏账 11-15 复核路径回归测试） |
| 解析容错：`parseExtractionAnswer` 清洗控制字符后重解析，仍失败保留原始答案落待重试 | 提取轨三笔账 | fixture：裸控制字符提案不再整批丢弃 |
| 提取正文去会话细节 + update 溯源列（**不加列；语义默认值 = 不刷新**，保持 `updateMemory` 不写来源列的现状；"刷新来源"选项关闭，版本链与 D9 一并留给 P4 ADR 联合决策） | 提取轨三笔账 | `dislike-temporary-solutions` 类正文不再含事故叙述；update 行来源可溯（现状语义：建行时会话） |

架构落点：读数链为 `services/injection-stats.ts`（生产）→ `surfaces/memory-snapshot.ts:156`（透传）→ `client/client.js`（`injection.rate` 实消费）+ 中英 locale `injectionLine`（消费），改名必须前后端同批；门槛状态无现成锚点（`src/` 内无 `changedSince`，`review-scheduler.ts` 现仅 `lastRunAt` + `minIntervalMs`），P1 ADR 定新 `state` 键（或 `item_events` 水位）与 reconcile 点；解析容错在 `services/extraction-prompt.ts:parseExtractionAnswer`；溯源语义：不加列，默认不刷新（保持 `updateMemory` 不写来源列的现状）；版本链问题与 D9 联合，留给 P4 ADR（见 P4 架构落点）。

### P2 提取轨借鉴（3 天，feature ADR）

| 项 | 出处 | 验收 |
|---|---|---|
| 两段式提取：分类 prompt（Identity/Override/Output 三测试 + evidence 强制引用）→ 生成 prompt 消费分类结果 | PilotDeck §5.1-7（`llm-extraction.ts:218/:2552` 设计重写） | user/feedback 边界 fixture 各 ≥2 例；分类失败整批不写 |
| **LLM 提案机械校验**：id 类字段与允许集求交、越界即丢、动作闭集验证（gap §5.1-3 本体） | PilotDeck 借鉴 §5.1-3（`normalizeDreamFileEntryIds` / `selectRecallProject` 越界丢弃的思路重写） | 伪造越界 id / 未知 action 的 fixture 全部被拒且不进写门 |
| 被拒候选逐条记 reason + `droppedWarnings` 入账本（拒因分布可统计） | PilotDeck §5.1-2 | `extraction_log` 可统计拒因分布；与 P0-G3 的红绿俱验配套 |
| 审计补 `prompt_json` 列：**只存失败与抽样，单条截断，30 天 retention**（D8） | PilotDeck §5.2-4 | 抽查任一失败行可复现当时调用；成功行仅采样；超期明细自动清理 |

架构落点：分类 prompt 为环资产，随 `services/extraction-ring.ts` 走（标准 §1"环自带提示词随环走"）；**开工先盘点**——动作闭集（`extraction-prompt.ts:213` 与 `memory-apply.ts:141` 各一遍）、`sourceSeqs` 证据字段、`scope` 越界清洗均已存在，P2 真新增仅三件（分类 prompt、id 求交、`droppedWarnings`），不许改出双重语义（三处校验长期会漂移，远期收敛到 `memory-rules` 唯一家，P2 ADR 先定方向）；落盘面与 D5 一致（`extraction-prompt.ts` / `memory-apply.ts` 同一份 ADR）。

### P3 门禁剩余批（7 天，执行细节走缺口清单 §3，批次命名以本计划为准）

- **G-batch1**（2 天）：G1 ADR 覆盖率 → G2 依赖环 → G4 预算棘轮
- **G-batch2**（2.5 天）：G5 导出面快照 → G12 归层白名单 → G9 测试配对
- **G-batch3**（2.5 天）：G7 历史词 → G8 Alternatives 质量 → G11 ast-grep → G10 变异抽样

注：缺口清单 §3 原「批次 A/B/C（P1/P2/P3）」命名与本计划阶段号撞车，以本节 G-batch 命名为准（缺口清单已加注记）；G-batch2/3 与 P5a 改动面零重叠（`scripts/` vs `evals/`），**可并行**；P5b（D11=A 已定，待 P5a 实测后重估开工）不参与并行。

架构落点：G12 初始允许集从标准 §1 推导（本计划 §1）；`evals/` 为仓库根新建目录，G12 只管 `src/`，不触发；G4 棘轮基线在 G-batch1 落地时按当时 `src/` 现状一次拍快照（含 P1/P2 新增在内，只约束未来增长）。

### P4 记忆生命周期（3 天；D9 扩大语义后含全量 update 迁移，开工前重估，超限拆 P4-b）

| 项 | 出处 | 验收 |
|---|---|---|
| `archive_reason` 列**首批三值**（promoted-source / review-archive / demoted-source）+ 一次性回填 + 卡片只读「已归档」区（上限 50 条、**默认折叠/置底**、无操作按钮）；`merged-duplicate` 随合并落地同批再加，不预占枚举进 G6 快照 | 归档可见性 ADR（执行入口不变） | 三类原因各一测试；折叠态默认 |
| 同源去重：提取落盘挂来源会话引用，同会话同主题走**版本行 + 归档旧行 `merged-duplicate`**（D9），并同步扩 G6 快照枚举 | PilotDeck §5.2-3 | 同会话重复提案只产生一条 active；旧行可从归档区看到；溯源列语义不被覆盖；版本链验收见 D9（归档/active 主键不冲突）+ §7.5 P4 三项（判定规则/回链字段/主键策略） |
| 条件删除：**归一化 diff**（去首尾空白/统一换行后逐字对比完整 body，不用截断预览）实质变化才删源，LLM 失败绝不删；合并吸收设上限（单次合并条数/字符预算，阈值在 ADR 拍板） | PilotDeck §5.2-2（含吸收窗口预算归位） | 失败路径零删除；空白级 diff 不触发删除；超上限的合并拆批 |
| staged 回滚评估：提级/批量合并是否需要 before/after 快照 + hash 校验回滚（做则同批 ADR；D2 已定不做 UI 恢复） | PilotDeck §5.2-1 | 评估结论落 ADR（做/不做皆可，不许悬置） |

架构落点：`archive_reason` 为 `memories` 真新增列（`schema.ts` 现只有 verdict 白名单），走 `data/migrate.ts` 迁移链；同源去重复用既有 `source_session` 列（`data/records.ts`），不加列；卡片归档区走 `pages/memory-card/` 只读投影，不开写入口（归档 ADR Alternatives 第 4 条）；提级事务入口为 `data/tiering.ts:promoteMemory`，staged 评估先看该事务的失败面再定。

### P5 评测基建统一（执行细节走 RSI 计划 §5，口径按 D1/D10 修订；拆 a/b：P5a 实现（fixture + recall 接线 + 表结构 + 防忘 infra，零 ctx 代码；runner 移 P5b，见 P5a ADR）→ P5b 跑批与 runner（D11=A 已定 2026-10-19，工时待 P5a 实测后单独重估——24 人日总数为占位符，对外不承诺）

#### P5a 实现（不需执行平面，可与 G-batch2/3 并行）

| 项 | 说明 |
|---|---|
| fixture/负例统一住 `evals/` | P0 回归集同时承载召回 A 的"每类记忆 + 负例 + 逐条覆盖" |
| **双 gate 接线**（D10） | 检索层 recall 退化进 CI 红；任务层 fitness 缺失只 warning（RSI P3 原语义） |
| **runner 设计与脚本**（D10，**移 P5b**：需 ctx/模型，P5a 只含零 ctx 代码） | P5b 落：宿主命令边界、多轮 tool_calls 求解环路、`--repeat 2` flaky 双跑、同一模型双 judge；`scripts/eval-tasks.ts` + `pnpm eval:tasks` |
| **caseTrace 落库实现**（评审补位，gap §5.1-1） | 新表 `eval_cases` 的形状 + data 层写入函数 + 迁移/G6/retention/脱敏（完整设计见 P5a ADR）；调用方 runner 与跑批验证归 P5b |

#### P5b 跑批与报告（D11=A 已定 2026-10-19；runner 设计与脚本归本批，开工前按 P5a 实测重估）

| 项 | 说明 |
|---|---|
| 确定性任务集跑批 | 同批两次 `acc` 必须一致，不一致标 `flaky` |
| judge 型 QA + 四臂报告 | 含 `recall_hit`（读注入账本）；外锚改双月 60 天（见 P5a ADR） |
| **runner 设计与脚本**（D11=A） | 宿主命令边界（scripts 离线 vs 宿主在线）、多轮求解环路、`--repeat 2`、同一模型双 judge；`scripts/eval-tasks.ts` + `pnpm eval:tasks --list/--dry-run/--subset` |

架构落点：执行平面待 D11 拍板（P5b 不开工直到定案，P5a 可先行）；caseTrace 落库同 D8 纪律（截断上限、采样率、回复脱敏规则，P5 ADR 定死；列还是新表由 P5 ADR 定——若新表，G6 加的是表，"同列入快照"说法随之改）；`evals/` 为仓库根新建目录（G12 只管 `src/`，不触发）；runner 若走宿主平面，模型路由复用 `services/llm-call.ts` + `model-route.ts`（`ctx.get("agentDefaultModel")`），不自建传输。

### P6 注入演进（0.5 天 + 条件项 + 一个决策门）

| 项 | 出处 | 说明 |
|---|---|---|
| 注入分层（源头四段 User Profile / Project Meta / Project Memory / Feedback Memory → 本插件映射见架构落点）+「与本轮指令冲突以本轮为准」守则 | PilotDeck §5.1-4 | 提示词两行；分层属构建期内容，冻结机制与字节稳定契约不变 |
| post-compact 重注入（**条件项**）：先核实宿主是否提供 compaction hook（web 无 workflowEngine；桌面端能力未验证），无 hook 即此项归档不做 | PilotDeck §5.2-5 | 验证结论落 ADR 注记，不许悬置 |
| **决策门**：每轮检索 vs 会话冻结（D3） | PilotDeck §5.2-6 | 依据 P5 的召回/成本数字拍板，倾向不动 |

架构落点：P6 ADR 第一节先给定映射表——`user/feedback/reference` × `scope global/project` × `data/resource-kinds.ts`（`MEMORIES_ORDER`）现有排序（feedback > user > reference 行级平铺，`memory-section.ts` 仅渲染行）→ 新分层；分层属构建期内容（标准 §1：section 文案随 surfaces 走），冻结机制不动。

## 4. 与既有文档的关系

| 文档 | 角色 |
|---|---|
| 本计划 | 唯一总入口与排序器 |
| [门禁缺口清单](2026-10-19-mechanical-gates-backlog.md) §2 | G1–G12 断言与验收原文；批次序以本计划 §3 为准 |
| [RSI fitness 计划](2026-10-18-memory-skill-rsi-fitness.md) §5 | P5 的执行细节（P0–P3 验收命令；D1/D10 修订注记在该文档 §5） |
| [召回度量 ADR](../../.agents/notes/proposed/architecture/2026-10-18-memory-recall-metrics.md) | P1-C 与 P5 口径的决策依据（A/B 并入见 D1） |
| [归档可见性 ADR](../../.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md) | P4 执行入口（软删立场见 D2，枚举三值起步见 P4） |
| [PilotDeck 差距分析](../research/pilotdeck-gap-analysis.md) | 借鉴项唯一出处库（文件:行号全在 §5） |

## 5. 排序理由与总成本

依赖链：**P0（G3 门禁可信 + G6 schema 基线）→ P1（独立，速赢）→ P2（新枚举/新列在 G6 快照下变更）→ P4（schema 变更同理）→ P5a（实现）→ P5b（跑批，用评测闭环验收前面所有改动）→ P6（注入决策依赖 P5b 数据）**。**P3 为平行轨**：G-batch2/3 与 P5a 改动面零重叠（`scripts/` vs `evals/`），可并行；G-batch1 的 G1（ADR 覆盖率）与 G9（测试配对）建议尽早落地——在此之前 P1/P2 的行为变更靠人工 ADR/测试纪律顶着，G-batch1 完成后须回溯补查一次。

总预算约 **24 人日 + 缓冲（占位符：P5b 待 D11 定案后单独重估，在此之前对外不承诺总数）**（P0 2.5 + P1 1.5 + P2 3 + P3 7 + P4 3 + P5a/P5b 原 6.5 拆分 + P6 0.5）。每阶段独立提交、独立验收，可随时在阶段边界停下，不存在跨阶段半成品。

## 6. Alternatives considered

- **13 条待办各自推进、不建总纲**：每条只写"触发条件"，无人负责跨条目排序与依赖（G6 先于枚举变更这类约束无处安放）；PilotDeck 条目与其他条目各执一词（软删冲突实证）。落败：整合正是本次动机。
- **按来源项目分批（PilotDeck 批 / 门禁批 / 召回批）**：来源不是架构关心的维度，同文件面的活会被拆到两批（提取三笔账与两段式）。落败：按轨道与依赖排序，出处只作引用。
- **P0 不抽先行、G3/G6 留在 P3 内**：P2/P4 的新枚举先于 schema 快照落地，G6 建基线时失去"变更即红"的验证机会；门禁可信性（G3）晚于首批新门禁。落败：v1 即此序，评审判为依赖倒挂。
- **立即评估每轮检索**：牵动 prompt cache 契约（不变量 2），且无自家召回数据支撑判断。落败：D3 推迟至 P5 后。
- **把 PilotDeck 六条立项项全部纳入独立"立项池"**：其中软删（D2）与每轮检索（D3）已有立场/已推迟，其余已分别归位 P2/P4/P5。落败：避免第二本账。
- **合并 RSI 与门禁为一个超级批次**：两者改动面零重叠（`evals/` vs `scripts/`），并行不互锁，合并只会推迟门禁收益。落败：保持两条轨道。

## 7. 开工检查单

1. `pnpm typecheck && pnpm lint && pnpm test` 基线绿（**以实跑为准**，2026-10-19 实测 700 测试 / 55 文件；文档静态数不作依据）；
2. 每阶段开工前复核 §2 决策表是否仍与既有 ADR 一致，有分歧先改 ADR 再动工；
3. 行为变更同变更携带 ADR；P2/P4/P5 新枚举新列确认在 P0-G6 快照覆盖下变更（P5 caseTrace 列同理，不许漏）；
4. **AGPL 防火墙**：P2/P4/P6 的 PilotDeck 借鉴施工只读 gap 分析 §5 的中文描述与本计划，不打开 PilotDeck 源码仓库；PR 描述自查声明无代码复制（逐行对照 AGPL 传染风险）；
5. 评审 5–9 项已并入本计划，各阶段开工时以该阶段 ADR 的对应条款落地，不再单独跟踪；**递延数字必须在开工 ADR 里定死、不许边写边定**：P1（`rate`→`readThrough` 的兼容判断——真调用链：生产 `injection-stats.ts` → 透传 `memory-snapshot.ts:156` → 消费 `client/client.js` + 中英 locale `injectionLine`；同批改完不留别名 vs 双字段一版，写明桌面端 bundle 缓存窗口结论）、P2（prompt_json 采样率与单条截断上限；两段式提取的 token 增量预估，调用数翻倍事前要有数）、P4（合并吸收上限的条数/字符阈值；同主题判定规则——LLM 判还是机械判〈同 id/同 title/相似度阈值〉；版本链指针的回链字段与主键策略）；
6. 阶段收尾：独立提交 + 本计划 §3 该阶段移入已完成指针 + HANDOFF 滚动窗记一行。
