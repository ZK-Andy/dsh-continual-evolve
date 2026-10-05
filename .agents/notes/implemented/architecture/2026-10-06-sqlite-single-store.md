# Agent Note: SQLite 单库记忆存储——代码唯一写者 + 提案制提取

Status: implemented

## Problem

2026-10-04 拆解后插件把记忆做成工作区内 md 文件（`<工作区根>/.evolve/memory/`），模型原生读写。使用中暴露的根性问题不在"文件形态"本身，而在**写路径无门禁**：

1. **模型直写存储 = 双写者**。指南只能劝（"当轮就写""更新优先于新建"），约束拦截不了任何坏写入：索引漂移靠约定维护，坏记忆靠用户手删兜底；secret 泄漏、frontmatter 漂移、超尺寸膨胀全部只发生在写完之后才可见。
2. **自动沉淀缺位**。依赖模型自觉"当轮就写"意味着提取时机完全随机：用户纠正过的做法可能没写、写了没进索引、写进了不该存的（决策/取舍类，该走 ADR）。
3. **10-04 选文件布局的唯一硬理由已经消失**。当时不用 home 目录中央库是因为"模型文件工具直写 `~/.dsh/` 会触发写围栏弹窗"——而 B 方案下模型不再直接写存储（显式走工具、自动走提案），该前提不复存在。插件代码写 `~/.dsh/evolve/` 有 v0.7–v0.10 数个月的无弹窗先例。
4. 运行时前提已验证：dotnet-desktop 实际运行时是系统 Node v26.8.1（EnsureNode 引导），`node:sqlite`（`DatabaseSync`）免 flag 直接可用，FTS5 trigram 中文检索实测通过（调研 §8 spike 全绿），零新依赖。

## Decision

**全部记忆状态就是一个中央数据库文件 `~/.dsh/evolve/memory.db`（按 `workspace_id` 行分区），插件代码是字面唯一写者，所有模型意图（显式指令与自动沉淀）都经结构化提案过机械门禁后由代码原子落盘。**

- **存储**：SQLite 单库（`node:sqlite`，Node ≥ 22.5，不可用时插件整体降级为无操作 + log 告警）。表：`memories`（STRICT，type/status 枚举 CHECK、body ≤64KB）、`memories_fts`（FTS5 trigram，查询恒带 workspace 过滤）、`extraction_log`（快照账本，update/delete 内嵌 before/after 全文，skip 也记账）、`state`（提取游标 seq:<n>）。WAL 模式；约束即门禁；**不设 MEMORY.md 文件**——注入索引是查询结果。规模护栏：账本超 12 个月导出归档后清除；启动对账孤儿行（工作区目录已删 → 行标记失联，不显示不阻塞）。
- **写路径 A（主会话显式指令）**：`memory_write` 工具（`defineTool` 等价形状经 `ctx.tools.register` 裸注册，`action: create|update|delete` + 字段）。代码侧统一校验后落盘：id 规范、type 枚举（user/feedback/reference）、feedback 必带 Why/How、secret 正则筛查（复用 v1 `2026-08-28-secret-leak-guard` 模式）、update/delete 前快照旧文入账本。老宿主工具注册失败 → 降级为指南提示口头管理 + 控制台告警，不阻塞注入。
- **写路径 B（自动沉淀，提案制提取）**：`turn/end`（`agent/turn-stopping`）轮级触发 + 空闲去抖（默认 10min，`memoryIndex.debounceMin` 可配）+ 单飞行合并突发 + `compaction/start` 强制 flush；内部 agent、空增量、无真实用户文本（≥3 词，CJK-aware）机械跳过并记账。执行 = 单次 LLM 调用（无工具、无 agent loop）：代码读 `readSurface` 增量、FTS 取相似候选喂模型，模型经 `outputSchema` 产出提案（create/update/delete/no-op），代码逐条校验后事务内原子应用、写账本、推进游标；失败不推进。ctx.llm 直调必须转发 host `GenerateOptions.sessionId`。
- **读路径**：开局注入改查库生成索引 section（order 400、会话内冻结、6k 预算整行截断逻辑沿用）；排序 feedback > user > reference；空库零 token。主会话指南缩为三行（库位置 / 显式记住忘掉走工具 / 其余沉淀有专职流程）。卡片改查库（条目/搜索/相对时间/预览）；工作区列表 = `SELECT DISTINCT workspace_id … WHERE status='active'`，原目录探测（`workspace-catalog.ts` + `known-workspaces.ts`）作废；`/memory/file` 按文件名取内容作废，改按 id。
- **巡检**：每次提取应用后代码执行（orphan FTS 行、超尺寸、secret 模式）→ 违规条目 `status='quarantined'`，账本记录，卡片显形；不物理删除。
- **迁移**：首次启动检测各工作区 `.evolve/memory/*.md` → 逐条导入对应 `workspace_id` 分区（frontmatter 解析复用原卡片逻辑）→ 原 MD 目录改名 `.evolve/memory-imported-<date>/`（不删不丢）。
- 本笔记 supersede `2026-10-04-zcode-alignment-teardown` 中"无工具、文件即真相"的拍板：**机械门禁优先于文件透明性**（拆解 ADR 自己的判据"模型提议，代码保证"以提案制形式回归）；工具面共 2 个（`memory_write` 写 + `memory_read` 读——注入只有索引钩子，模型取正文需要它），职责单一，不复现 v0.11 时代的工具堆。10-04 拍板中仍然成立的部分（机制要少、层级虚空、治理三件套不做）保持不变——本决定只加"一个库 + 两个工具 + 一条提取轨"，不复活任何被拆机制。

## Alternatives considered

- **MD + 提案制（A 案）**：保留文件透明性，提案写回 md。落败：门禁靠 frontmatter 解析 + 索引对账 + 文件锁四件套拼合，跨文件无事务；且 B spike 全绿后 A 无独有优势。
- **双写者（主会话顺手写 + 后台兜底）**：ZCode 同款 + eligibility 补丁。落败：兜底即双 owner，违背单一写者判据；取证证明主会话顺手写不可靠（这正是 Problem 1）。
- **`.evolve` 内部 git**：用户否决（2026-10-06）——用户环境不能假设装了 git；嵌套 `.git` 与项目 git/IDE 工具链纠缠。回滚需求由快照账本承担（undo = 取 before 重写）。
- **JSON store 回归**：v1 遗产可复用但破坏人机共读与 ZCode 对齐；其"代码强制"内核以提案制 + 约束的形式回归，格式不回归。
- **SQLite + MD 投影并存**：双真相 = 双写者换皮，否决。
- **per-turn 无去抖提取（纯 ZCode 形态）**：更及时但成本高（每轮后台跑）；ZCode 本机实测 7 天 30 次可接受，但去抖把"连续对话每轮一次"压成"每次停顿一次"，经济性更好。保留为可配置退化方向（`debounceMin: 0`）。

## Consequences

- 架构规范第 4.3 条"零后台自动化"不变量随之修订：提取轨是**有账可算的常驻自动化**（ZCode 同款经济学：7 天 30 次运行 29 次有写动作），触发参数全部可配、提取全程记账（`extraction_log` 可对账），且只在有真实用户文本的增量上花 LLM 调用。不变量 1、2（注入不破坏组装、会话内字节稳定）不变。
- 记忆库脱离工作区目录：跨 profile 共享、不进 git、不随仓库迁移；卡片工作区列表改为查库结果，原"目录探测 + 注册表"链路整体退役。
- 密文边界从"文件权限"变为"数据库文件权限"：`~/.dsh/evolve/` 沿用 DSH home 既有权限面，secret 在写入前拦截，账本里 before/after 快照同样过 secret 筛查。
- 12 个月账本归档是唯一长期维护项（年增 ~20MB）；50 工作区 × 100 条 ≈ 25MB，距 SQLite 舒适区 3–5 个数量级，性能哨兵 = 账本 durationMs 与会话启动耗时，若真触及瓶颈按 workspace 拆文件是机械操作而非重构。
