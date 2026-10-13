# 设计：一个库，一个写者，模型提议代码保证

> v0.15 SQLite 单库改造后的设计。此前的"文件就是 store"（工作区 md 文件 + 模型原生读写）由 ADR [`../.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](../.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md) supersede——文件形态的证据链与"零治理"取舍见 [ADR `2026-10-04-zcode-alignment-teardown.md`](../.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md)；决策依据与五路调研全文见 [`research/memory-update-retirement-survey-2026-10-06.md`](research/memory-update-retirement-survey-2026-10-06.md)，历史设计见冷归档 [`research/design-v1-2026-08-14.md`](research/design-v1-2026-08-14.md)，踩坑记录见 [`FAQ.md`](FAQ.md)。

## 核心主张

**全部记忆状态就是一个中央数据库文件 `~/.dsh/evolve/memory.db`（按 `workspace_id` 行分区），插件代码是字面唯一写者，所有模型意图（显式指令与自动沉淀）都经结构化提案过机械门禁后由代码原子落盘。**

## 形态

```
~/.dsh/evolve/memory.db          # SQLite 单库（node:sqlite，WAL，FTS5 trigram 中文检索 + 关键词 AND/LIKE 兜底）
├── memories                     # 记忆条目（STRICT；type/status 枚举 CHECK；body ≤64KB）
├── memories_fts                 # 全文索引（与 memories 同事务内由代码同步）
├── extraction_log               # 快照账本：每次变更内嵌 before/after 全文；skip 也记账，同会话连续空转合成一行（occurrences 计次）
├── skills                       # 技能条目（STRICT；无 type；body ≤64KB；`""` 分区 = 全局）
├── skills_fts                   # 技能全文索引（与 skills 同事务内由代码同步）
├── skill_log                    # 技能账本：每次变更内嵌 before/after 全文 + 文件投影告警
├── skill_usage                  # 技能存在心跳：按 id 取回正文 +1（聚合，无无界增长）
├── memory_usage                 # 记忆存在心跳：同技能纪律（按 id 取回正文 +1）
├── review_log                   # 内容评审 verdict 明细：每条一 verdict（keep/rewrite/quarantine/skip）+ 跑在哪个模型 + 便宜/贵用量 + 落盘标志 + 未落盘时的拟改稿，随账本轮转
├── review_daily                 # 日 rollup（一行一天）：预算 vs 实审 vs 积压 vs 丢弃 + token 按便宜/贵分账
└── state                        # 提取游标（seq:<n>，按工作区+会话分隔）与巡检状态
```

- **开局注入**（`src/memory-section.ts`）：`evolve:memory-index` section（order 400）注入本工作区的记忆索引——查库结果而非文件，只含钩子（id/标题/描述/类型），feedback > user > reference 排序；超预算按整行截断并提示 `memory_read` 检索。会话内逐字节冻结守 prompt cache；空 store 零 token。
- **唯一写门**（`src/store-apply.ts` + `src/memory-rules.ts`）：两条写路径共用同一入口 `applyProposals`——全量校验（type 枚举、尺寸上限、id 规范含 CJK hash 兜底、feedback 的 Why/How 契约、v1 移植的 secret 正则筛查）→ 事务内原子应用 → 账本行（before/after 全文）。任何一条提案被拒，整批回滚且不推游标。
- **写路径 A：`memory_write`**（`src/memory-tools.ts`）：主会话显式"记住/忘掉"走工具；`memory_read` 按 id 取正文、按关键词检索（空格分隔的关键词取 AND：全部 ≥3 字符走 trigram，任一短词或 FTS 未命中则回退字面子串匹配；注入索引只有钩子）。宿主工具定义手写为裸注册形状（标准 JSON Schema、根级 required，FAQ #2），零运行时 DSH import。
- **写路径 B：提案制提取**（`src/extraction*.ts`）：轮级调度 + **按会话分槽**（每会话一个 pending 槽与在飞运行；运行中只保留最新边界即合并，compaction/会话关闭触发 drain，**无空闲计时器**）→ 读轨迹增量（`seq:<n>` 游标）→ 机械跳过（内部 agent/空增量/无真实用户文本 ≥3 词/当轮已有显式写入）并记账（同因连续跳过合成一行、累计唤醒次数；故障型跳过与失败仍逐次成行）→ **便宜预检门**（增量前 4KB + 归属三测，小 verdict，拒了直接按 model-skip 消费游标；门不清不楚就透传给贵调用，永不 stall）→ FTS 取相似候选 → 单次 LLM 调用产出闭集提案（create/update/delete）→ 过写门落盘 → 推游标 → 巡检随跑。失败（含管线内任何未预期的抛错：`unexpected-error` 失败行，message 头进 skip_reason、堆栈头进 files）不推游标，下次重试；只剩账本本身不可写时才走调度器 warn。贵调用与预检调用的用量分 `usage` / `cheap_usage` 两列记账（两处调用都经装载器，定义为 `extraction-gate` / `extraction-main`）；贵调用失败时 `llm-failed` 行带上跑在哪个模型与调用死前已报出的 usage；门自己抛错时按 fail-open 透传，错误原文留在同一行的 `cheap_error` 里（门死了与门不存在可区分），门已报出的 usage 也留在该行。
- **写路径 C：技能**（`src/skill-rules.ts` + `src/skill-tools.ts` + `src/store.ts` 技能面）：`skill_write`（create/update/delete + 手动搬到全局）与 `skill_read`（按 id 取正文、按关键词检索），镜像记忆工具的裸注册形状与门禁（短横线 id 含 CJK hash 兜底、secret 正则、64KB 上限），另加跨范围纪律——创建只能是项目（全局只接受手动搬家，无晋升机制）、同名全局已存在即拒绝（内容相同提示直接调用）、正文完全相同即拒绝（指向已有的那条）。落库成功后同批物化：项目技能写回本工作区 `.agents/skills/<id>/SKILL.md`，全局技能写 `~/.dsh/skills/<id>/SKILL.md`（原子 tmp+rename，frontmatter `name/description` 携带路由 hint）。**库是唯一真相，文件是只读投影**：模型禁直写文件，文件头打生成标记，巡检发现缺失/漂移按库重写、无主托管文件删除、手改文件保留并告警。
- **读技能**：项目优先——同 id 时项目行遮蔽全局行（读、检索、列表、卡片一致）；全局行只能显式指定范围更新或删除。手动搬家是搬家不是复制：全局建行 + 物化，同时项目行归档 + 项目文件删除，永远只有一份 active。
- **子代理与装载器**（`src/subagent.ts` + `src/subagent-defs.ts` + `src/chain.ts`）：插件所有 LLM 调用只有一个入口——装载器 `loader.run(定义, prompt)`。一份子代理定义 = 一个策略（身份、完整 system 提示词、预算兜底、应答解析器），六份定义（评审四岗位 + 提取两岗位）声明在一张表里，feature 代码不写提示词也不 import 传输层（有结构性回归锁死）。执行骨架是模板方法：装配 → 调用 → 解析 → 记账固定；流程推进是责任链（评审环 门 → 昂贵门 → 落盘；提取环 预检门 → 提案调用），链路由环境类组装、无终局环节即 fail loud。传输层 `src/llm-call.ts` 统一解析路由、推理档位与输出预算（取模型自己广告的 per-request 上限，定义值只兜底），并把失败前已观测到的 usage/finish/route 挂在 `SubagentCallError` 上——失败行与成功行一样可归因。
- **内容质量自进化轨**（`src/review*.ts` + `src/token-usage.ts`，与提取轨并行、不共享游标与提示词，只共享库写门）：便宜门模型先判某条记忆/技能值不值得细看，批了才跑贵改写（归属三测打头：主语是用户/环境还是某仓库的某版机制、去名后还成立吗、仓库事实住 ADR/docs；记忆再按准确/可用/可复用/不重复/不过时五维、技能按触发精度/可执行完备/不重复三维（「可复用」按分区判：项目分区技能按该项目内跨任务可用判，跨项目可用只对全局分区技能判；绑定本仓库路径/门禁/流程的项目技能不算缺陷，只有全局分区却绑某仓库才算放错家），只输出 keep/rewrite/quarantine 结构化 verdict，放错家进 quarantine）。记忆与技能各装各的说明书（四个岗位四份提示词——一份服务不了两者：记忆要求抹掉仓库名仍成立，项目技能本来就该绑仓库）。同一套归属三测守在提取 prompt 门口。调用失败记错误原文进 verdict 行，连同跑在哪个模型与该调用已烧掉的 usage 一并落账；输出预算取模型自己广告的上限（截断前已解析出的 verdict 仍算数），一条 verdict 都没产出的调用不让条目记为已评审、下轮可重试。新写即审、存量有界积压排空、`review.staleDays`（默认 30 天）未动回炉；删除永不自动落盘（只改写与隔离），超 30% 幅度改写自动转隔离；日上限 100 条（新写 > 被纠正牵连 > 陈旧 > 抽查，尾部丢弃）。用量经 `normalizeUsage` 归一并按便宜/贵分账；`review_log` 记每条终态（含 model 列）、`review_daily` 一天合一行。默认试运行（`review.dryRun` 开）：只记 verdict 不落盘，未落盘的拟改稿全文随行进 `proposed` 列（试运行要看的是「改成什么样」，不只是「为什么改」）。
- **回滚靠账本**：undo = 取账本 before 快照重写；终极兜底是会话轨迹本身（记忆是轨迹的投影，`source_seqs` 可回放溯源）。
- **巡检**：每次提取应用后随跑——孤儿 FTS 行清除、active 行 secret 扫描 → 命中行 `status='quarantined'`（隐藏不删，卡片显形；被隔离技能的物化文件一并撤下）+ 技能文件对账（缺失/漂移重写、无主托管文件删除）。
- **只读卡片**（`src/memory-snapshot.ts` + `src/card-routes.ts` + `client/client.js`）：官方插件管理内一张只读卡片，形态对齐市场设置卡、内容对齐 ZCode 记忆选项卡——工作区下拉（= 库内记忆与技能分区的并集，目录已删的分区失联不显示不阻塞；全局技能随打开的工作区附带显示）、搜索、相对更新时间、按 id 的内容预览（5 MiB 上限）、技能区（项目技能 + 可见全局技能，全局行打标记）与巡检异常警告。宿主缺 `webServer`/slot 自动降级。显示名/描述走 `locale/*.json` 双语通道。
- **迁移**（`src/import-md.ts`）：首次接触某工作区时检测旧版 `.evolve/memory/*.md` → 无损导入该工作区分区（缺 frontmatter 字段就地合成，secret 命中的跳过并留在归档目录）→ 原目录改名 `memory-imported-<date>/`。
- **降级**：`node:sqlite` 不可用（Node < 22.5）→ 注入与工具停用、log 告警、宿主不受影响；桌面宿主的 EnsureNode 运行时保证正常环境不触发。

## 为什么不是原来的样子（各一句话）

- **工作区 md 文件（10-04 形态）**：文件透明但写入不设防——索引漂移、frontmatter 腐坏、secret 泄漏全靠写后人工兜底；机械门禁优先于文件透明性（拆解 ADR 自己的判据）。
- **中央 md 库或 JSON store**：跨文件无事务、门禁靠约定拼合、破坏人机共读；SQLite spike 全绿后（FTS5 trigram 中文检索实测通过、约束即门禁）无独有优势。
- **双写者（主会话顺手写 + 后台兜底）**：兜底即双 owner；取证证明主会话顺手写不可靠。
- **层级（global/project/local）**：ZCode 按工作区分库，工作区多大记忆覆盖面就多大；实测 global 存量只有 4 条。
- **治理机器（审批/版本/benchmark）**：为不存在的多人场景付费；账本 + 软隔离以千分之一的机制量覆盖了同样的风险面。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 注册记忆 section |
| `memoryIndex.guide` | `true` | 注入指南（关闭且索引为空时该 section 零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxChars` | `6000` | 注入索引的硬字符预算 |
| `memoryIndex.extraction` | `true` | 提案制提取运行（轮级、按会话分槽、无空闲计时器） |
| `review.enabled` | `true` | 内容质量自进化环（自有提示词/预算/账本，默认试运行） |
| `review.dryRun` | `true` | 只记 verdict 不落盘（试运行分布看顺后再关） |
| `review.dailyBudget` | `100` | 每天评审上限（新写 > 被纠正牵连 > 陈旧 > 抽查，尾部丢弃） |
| `review.batchSize` | `10` | 每次 drain 最多审几条 |
| `review.staleDays` | `30` | 已评审条目重回队列前要等几天（没产出 verdict 的评审从不算数） |
| `memoryCard.enabled` | `true` | 官方插件管理内的只读记忆卡片 |

## 设计来源

- **ZCode 记忆系统**：形态蓝本——按工作区分区、类型化记忆、开局注入、轮级提取 + 合并突发（源码级分析见 [`research/zcode-memory-parity-analysis.md`](research/zcode-memory-parity-analysis.md) 与 [`research/zcode-reasoning-and-memory-agent-analysis.md`](research/zcode-reasoning-and-memory-agent-analysis.md)）。
- **Mem0 / Hermes / v1 设计**：提案制写入与快照账本的来源（ADD/UPDATE/DELETE 闭集、before/after 历史乐观回滚、secret 门禁不可配置）；调研见 [`research/memory-update-retirement-survey-2026-10-06.md`](research/memory-update-retirement-survey-2026-10-06.md)。
