# 设计：一个库，一个写者，模型提议代码保证

> v0.15 SQLite 单库改造后的设计。此前的"文件就是 store"（工作区 md 文件 + 模型原生读写）由 ADR [`../.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](../.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md) supersede——文件形态的证据链与"零治理"取舍见 [ADR `2026-10-04-zcode-alignment-teardown.md`](../.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md)；决策依据与五路调研全文见 [`research/memory-update-retirement-survey-2026-10-06.md`](research/memory-update-retirement-survey-2026-10-06.md)，历史设计见冷归档 [`research/design-v1-2026-08-14.md`](research/design-v1-2026-08-14.md)，踩坑记录见 [`FAQ.md`](FAQ.md)。

## 核心主张

**全部记忆状态就是一个中央数据库文件 `~/.dsh/evolve/memory.db`（按 `workspace_id` 行分区），插件代码是字面唯一写者，所有模型意图（显式指令与自动沉淀）都经结构化提案过机械门禁后由代码原子落盘。**

## 形态

```
~/.dsh/evolve/memory.db          # SQLite 单库（node:sqlite，WAL，FTS5 trigram 中文检索 + 关键词 AND/LIKE 兜底）
├── memories                     # 记忆条目（STRICT；type/status 枚举 CHECK；body ≤64KB）
├── memories_fts                 # 全文索引（与 memories 同事务内由代码同步）
├── extraction_log               # 快照账本：每次变更内嵌 before/after 全文，skip 也记账
└── state                        # 提取游标（seq:<n>，按工作区+会话分隔）与巡检状态
```

- **开局注入**（`src/memory-section.ts`）：`evolve:memory-index` section（order 400）注入本工作区的记忆索引——查库结果而非文件，只含钩子（id/标题/描述/类型），feedback > user > reference 排序；超预算按整行截断并提示 `memory_read` 检索。会话内逐字节冻结守 prompt cache；空 store 零 token。
- **唯一写门**（`src/store-apply.ts` + `src/memory-rules.ts`）：两条写路径共用同一入口 `applyProposals`——全量校验（type 枚举、尺寸上限、id 规范含 CJK hash 兜底、feedback 的 Why/How 契约、v1 移植的 secret 正则筛查）→ 事务内原子应用 → 账本行（before/after 全文）。任何一条提案被拒，整批回滚且不推游标。
- **写路径 A：`memory_write`**（`src/memory-tools.ts`）：主会话显式"记住/忘掉"走工具；`memory_read` 按 id 取正文、按关键词检索（空格分隔的关键词取 AND：全部 ≥3 字符走 trigram，任一短词或 FTS 未命中则回退字面子串匹配；注入索引只有钩子）。宿主工具定义手写为裸注册形状（标准 JSON Schema、根级 required，FAQ #2），零运行时 DSH import。
- **写路径 B：提案制提取**（`src/extraction*.ts`）：轮级触发 + 空闲去抖（默认 10min，单飞行合并突发，compaction/收尾强制 flush）→ 读轨迹增量（`seq:<n>` 游标）→ 机械跳过（内部 agent/空增量/无真实用户文本 ≥3 词/当轮已有显式写入）并记账 → FTS 取相似候选 → 单次 LLM 调用产出闭集提案（create/update/delete）→ 过写门落盘 → 推游标 → 巡检随跑。失败不推游标，下次重试。
- **回滚靠账本**：undo = 取账本 before 快照重写；终极兜底是会话轨迹本身（记忆是轨迹的投影，`source_seqs` 可回放溯源）。
- **巡检**：每次提取应用后随跑——孤儿 FTS 行清除、active 行 secret 扫描 → 命中行 `status='quarantined'`（隐藏不删，卡片显形）。
- **只读卡片**（`src/memory-snapshot.ts` + `src/card-routes.ts` + `client/client.js`）：官方插件管理内一张只读卡片，形态对齐市场设置卡、内容对齐 ZCode 记忆选项卡——工作区下拉（= 库内 `SELECT DISTINCT workspace_id`，目录已删的分区失联不显示不阻塞）、搜索、相对更新时间、按 id 的内容预览（5 MiB 上限）、巡检异常警告。宿主缺 `webServer`/slot 自动降级。显示名/描述走 `locale/*.json` 双语通道。
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
| `memoryIndex.extraction` | `true` | 提案制提取运行 |
| `memoryIndex.debounceMin` | `10` | 轮末空闲去抖分钟数（0 = 每轮即跑） |
| `memoryCard.enabled` | `true` | 官方插件管理内的只读记忆卡片 |

## 设计来源

- **ZCode 记忆系统**：形态蓝本——按工作区分区、类型化记忆、开局注入、轮级提取 + 合并突发（源码级分析见 [`research/zcode-memory-parity-analysis.md`](research/zcode-memory-parity-analysis.md) 与 [`research/zcode-reasoning-and-memory-agent-analysis.md`](research/zcode-reasoning-and-memory-agent-analysis.md)）。
- **Mem0 / Hermes / v1 设计**：提案制写入与快照账本的来源（ADD/UPDATE/DELETE 闭集、before/after 历史乐观回滚、secret 门禁不可配置）；调研见 [`research/memory-update-retirement-survey-2026-10-06.md`](research/memory-update-retirement-survey-2026-10-06.md)。
