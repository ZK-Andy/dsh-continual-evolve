# 开发计划：经典分层＋通用仓储重构（统一读写工具）

> 状态：**已拍板待实施**（2026-10-15 用户拍板：经典分层＋通用仓储；统一读写工具 `evolve_write`/`evolve_read`；自创技能一律 `evolve_*` 前缀；物理并表否决；自带技能进 repo + 修 `.agents/AGENTS.md` 规则）。
> 本文是唯一执行入口，供新会话按序施工。
> 实施纪律：开工第一件事落 ADR（Alternatives 素材见 §8）；非平凡变更同变更携带；每阶段独立提交、测试全绿；**发版动作不在本计划内**。

## 0. 拍板结论（一句话与要点）

**一句话**：表现层 / 应用服务层 / 数据访问层三层 + 通用仓储；模型可见工具收敛为**一个读、一个写**（`kind` 参数区分管理对象）；底层表不动、行为等价迁移。

- 三层单向依赖：表现 → 应用服务 → 数据访问；`index.ts` 仍是唯一组装根。
- 通用仓储把 CRUD、FTS、分区、usage 心跳、prune、巡检对账收成一份；每类管理对象 = 建表 DDL 一段 + 一份仓储实例化参数（表名、列、id 规则、门禁组合、FTS、投影、账本、读面资格）。
- 统一工具（已拍板）：`evolve_write(kind, action, …)` / `evolve_read(kind, …)`；旧四个工具保留一版做薄垫片（退役规则），下版删除。
- 存储单写者不变量不变：模型任何路径都不直写存储，投影文件仍为只读投影；注入失败降级、section 字节稳定不变。
- 配套硬约束：把模块规模预算搬上机器门禁（§6 P0），否则架构会再次长歪。

## 1. 问题（量化，2026-10-15 实测）

| 事实 | 数值 |
|---|---|
| `src/store.ts` 行数 | **1635**（规范上限 400，超标 4 倍）；421（10-06）→ 1138（10-11 技能接线 +717）→ 1635（今天） |
| 语句复制 | `store.ts` 内 59 处 `database.prepare`；`skill*` 前缀 18 条 = 无前缀那套逐条加前缀的复制 |
| 镜像文件 | **12 个文件**同时躺着两份同名镜像（store、rules、tools、snapshot、card-routes、review-candidates…） |
| 工具复制 | `memory_write`/`memory_read` 与 `skill_write`/`skill_read` 同一形状各写一遍 |
| 门禁缺位 | `scripts/run-gates.ts` 五项全是文档侧；**没有任何脚本量 `src/` 行数/出度/函数长度** |

**根因**：没有数据层——存储、门禁、投影、账本摊在功能代码里，"新增一类对象"的唯一路径就是水平复制。

## 2. 架构（选型结论，不再论证过程）

采用**经典分层＋通用仓储**（Fowler《企业应用架构模式》：Service Layer + Repository + Transaction Script——中小型 CRUD 项目的现成答案）。

- **表现层（前端）** `src/surfaces/`：工具注册、卡片路由、注入 section、投影物化与巡检。只做"翻译与渲染"，不得出现表名与 SQL。
- **应用服务层** `src/services/`：门禁规则组合、提案校验与落盘语义、评审环/提取环的调用编排（环与链的实现原样保留）。
- **数据访问层（后端）** `src/data/`：`Database`（open/migrate/tx/WAL 一处）、通用 `Repository`（CRUD/FTS/分区/usage/prune/巡检）、迁移脚本。
- 不用完整领域架构：单存储、单进程、对象同构，接口永远没有第二个实现——那是仪式，不是分层。

## 3. 统一工具面（本计划的硬要求）

- **写就一个**：`evolve_write(kind, action, scope, …字段)`——`kind: memory | skill | …`；门禁组合按 `kind` 取；`scope: project | global` 覆盖今天的搬家语义。
- **读就一个**：`evolve_read(kind, id?, query?, limit?)`——按 id 直取 / 关键词检索 / 列目录；项目遮蔽全局保留。
- 旧四个工具（`memory_write`/`memory_read`/`skill_write`/`skill_read`）保留**一版**做薄垫片（只转调新工具），下版按退役规则删除。
- 工具命名已拍板：`evolve_*`（插件名前缀，避免与宿主 `skill` 工具撞名）。

## 4. 数据层与迁移（已拍板：不并表）

- 底层仍是 `memories` / `skills` 两张表（外加各自 FTS 与 usage/账本表），仓储按"表名 + 列 + 规则"参数化。**不迁数据、不重建 FTS**。
- 表按对象分是关系建模常规做法：`type`/`corrects` 已是记忆专属列，硬并会引入无用 nullable 列或 JSON blob，违反"约束即门禁"纪律；将来提示词/子代理规格分叉更大。统一的是访问层，不是物理表。物理并表 2026-10-15 已否决，不在本计划内。
- 行为等价要求（每阶段验收前提）：落盘结果与 id、门禁拒绝文案、账本行（含 skip 与失败原文）、投影文件字节（含生成标记）、注入索引字节、卡片响应形状——逐项对照。测试是全量 409 条不降级。

## 5. 模块布局与预算（对齐 `../architecture-standard.md` §2）

| 目录 | 文件（初版） | 职责 |
|---|---|---|
| `src/data/` | `database.ts` `repository.ts` `migrate.ts` | 连接/事务/迁移/通用仓储 |
| `src/services/` | `gates.ts` `proposals.ts` `resource-kinds.ts` | 可组合门禁规则 + 两类对象的实例化参数 + 提案应用 |
| `src/surfaces/` | `tools.ts` `card-routes.ts` `injection.ts` `projection.ts` `patrol.ts` | 表现层：两个统一工具、卡片、注入、投影与巡检 |
| 保留不动 | `review-ring.ts` `extraction-ring.ts` `chain.ts` `subagent*.ts` `llm-call.ts` `retention.ts` `token-usage.ts` | 领域逻辑资产，只改 import 指向 |

每个文件 ≤ 400 行、出度 ≤ 12（P0 上门禁后即为硬约束）。

## 6. 分阶段任务与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 新增 `scripts/verify-src-budgets.ts`（行数/出度/函数长度）纳入 `run-gates`；ADR（问题量化 + 选型 Alternatives） | 门禁在 `store.ts` 上**必须报红**（证明有效）；ADR 门禁绿 |
| **P1** | `src/data/` 落地；记忆改走通用仓储（仍住 `memories`） | 行为等价 §4；409 测试全绿 |
| **P2** | 技能改走通用仓储；门禁改为规则组合 | 同上；`memory-rules`/`skill-rules` 的重复消失 |
| **P3** | 统一工具落地（新读写工具 + 旧四个垫片） | 新工具全链路；旧工具行为等价（垫片回归测试） | ✅ 2026-10-15：`src/evolve-tools.ts`（kind 调度）+ `evolve-memory.ts`/`evolve-skills.ts`（各对象执行，旧文案逐字保留）+ 旧四文件薄垫片（只转调核心）+ `index.ts` 注册六工具；`test/evolve-tools.test.ts` 13 条；422 测试全绿；src 预算除 `store.ts` 外全绿（P4 收） |
| **P4** | 表现层收敛；`store.ts` 拆解至 ≤ 400 行归位 | P0 门禁全绿（无豁免） | ✅ 2026-10-15：类型层 `store-types.ts`（326）+ `data/records.ts`/`resource-kinds.ts`/`ledger.ts`/`review-accounts.ts` + `services/skill-apply.ts`（252）+ `surfaces/skill-projection.ts`（174）；`store.ts` 1340→370 纯装配（语句准备 + 方法拼装 + 巡检），对外名字 re-export 零调用方改动（仅 `store-apply.ts` 改一行类型源）；422 测试全绿，`run-gates docs` 全绿 |
| **P5** | 第三类对象试接入（提示词补充或子代理规格） | 只加仓储实例化参数 + 描述字段；工具/卡片/投影/账本自动出现；新增回归测试锁死 | ✅ 2026-10-15：选 prompt（提示词补充；确认零存量，空表试接入、无旧数据迁移）：`prompts`/`prompts_fts`/`prompt_log`/`prompt_usage` DDL + `PROMPTS` 描述符 + `prompt-rules.ts` 门禁 + `services/prompt-apply.ts`（178）写路径 + `evolve-prompts.ts` 执行器 + `prompt-snapshot.ts`/`prompt-routes.ts` 卡片（围栏自动纳入）+ 巡检/usage/最近活跃/裁剪全跟进；`evolve_*` kind 三元；`test/prompt-kind.test.ts` 12 条；434 测试全绿，门禁全绿；刻意未做：评审环（无 rubric）、注入、旧垫片删除（下版） |
| **P6** | 自带技能：手写 `evolve-skill-creator` + `evolve-memory-creator` 进 repo `.agents/skills/`；修订 `.agents/AGENTS.md` 技能节（原版规则仅限 `dsh-*`，见 §9） | 宿主技能目录可见、可加载；`check:docs` 全绿 | ✅ 2026-10-15：讨论先行（官方模板做底＋memory 照 skill 结构写＋只讲怎么写）；`evolve-skill-creator` 仿 `anthropics/skills` skill-creator 结构（命名/访谈/正文/门禁自检/不写落盘指令），`evolve-memory-creator` 同结构、规则来自 `memory-rules.ts`；`.agents/AGENTS.md` 技能节修订＋出处声明拆分（dsh-* 上游 / evolve_* 自创）；434 测试全绿，`run-gates docs` 全绿 |
| **P7** | 表现层收敛最终收口（审计追加）：删旧四垫片、去重、搬家、stmt 下沉、文档同步 | `tsc`＋`oxlint`＋全量测试绿、`run-gates docs` 绿、零预算红灯 | ✅ 2026-10-15：删 `memory/skill-tools` 源＋测试、指南/注入文案与提取显式写入检测跟进 `evolve_*`（skipReason 保持 `direct-memory-write` 不动试运行账本连续性；marker 冻结）；`evolve-fields`/`card-http`/`LedgerFile`/`writeLedger`/`MemoryRow` 去重；表现层 10 文件→`surfaces/`、`store-apply`→`services/memory-apply`＋三套 rules→`services/`；`prepareLedgerStmts`/`prepareReviewStmts` 下沉、`store.ts` 293 行；`section-registered` 丢日志一并修复（移进 `.then`＋回归测试）；`design.md`/`architecture-standard.md` 同步 |

## 7. 明确不做（防过度设计）

不做 DI 容器；不引 ORM（`node:sqlite` 手写语句，只是集中到一处）；不做领域事件；不做每资源一个接口 + 实现类的层次；不做多套读写工具（§3 是硬要求）；不改评审环/提取环/责任链的实现；不做多后端抽象；不做物理并表（2026-10-15 用户否决）；不在本计划内发版。

## 8. ADR Alternatives 素材

- **完整领域架构（接口 + 每资源实现 + 领域事件）**：判据——单存储/单进程/对象同构，接口无第二实现；无跨聚合事务。落败：仪式成本 > 收益。
- **自创描述符框架（2026-10-15 上午版，已废）**：业界无此物，等于把 DDD 拆碎重拼。落败：用户否决。
- **物理并表（`resources(kind, …)`）**：列已分叉（`type`/`corrects` 记忆专属）、硬并违反约束纪律、将来分叉更大还得拆。落败：2026-10-15 用户否决。
- **继续现状（新增对象继续水平复制）**：`store.ts` 每类 +500~700 行的实测轨迹。落败。
- **统一工具命名**：已拍板 `evolve_write`/`evolve_read`（插件前缀，不撞宿主 `skill`）；备选沿用 `memory_write` 为统一入口（语义偏记忆，未采纳）；按表各一套已否决（用户明确一个读一个写）。
- **自带技能归属**：放 DB（新克隆没有、无版本）/ 放全局 `~/.dsh/skills/`（无归属、与搬家物化混淆）。落败：进 repo `.agents/skills/`，自创一律 `evolve_*` 前缀。

## 9. 自带技能归属（已拍板）

- 出厂自带的技能一律手写进 repo `.agents/skills/`：git 版本化，cwd 进 repo 即被宿主发现加载——"自带"二字只有这个家成立。
- 自创技能一律 `evolve_*` 前缀并注明自创出处；11 个 `dsh-*` 保持上游原样不动。`.agents/AGENTS.md` 技能节同步修订：原版规则仅限 `dsh-*`（该文件预算 300 词、现 133，有空间）。
- DB（`skill_write`）只放运行时沉淀的技能（要评审、要版本、要回滚）；全局 `~/.dsh/skills/` 不放手写文件。
- 首批两份（§6 P6）：`evolve-skill-creator`（技能怎么写）、`evolve-memory-creator`（记忆怎么写）——补"内容规范缺失"的洞。
- 上游参考（待讨论，P6 动手前补）：两份各找一份上游参考（skill-creator 找官方模板，memory-creator 找记忆写作的上游参考），本次只记项、不调研。

## 10. 执行会话开场检查单

1. 读本文 + `../architecture-standard.md` + `../design.md` + `../FAQ.md`；按仓库 `session-open` 走 git 对账与门禁基线（409 测试 / 30 文件）。
2. P0 落 ADR 后按 §6 表施工；每阶段 Conventional Commits 独立提交、测试全绿。
3. 每阶段结束回填本节进度与实测数字（行数、镜像文件数），下一会话据此续接。
