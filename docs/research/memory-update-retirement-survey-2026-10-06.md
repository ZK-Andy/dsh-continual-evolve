# 记忆更新与退役机制调研（2026-10-06）

> 问题：记忆更新怎么做到**不丢、不乱**，以及**退役机制**怎么做。
> 五路来源：①主流记忆系统联网调研；②③「项目画像」概念与做法联网调研；④Hermes（NousResearch）自进化与记忆系统联网调研；⑤本仓库遗留自进化文档与 ADR 重读（v1 设计 / v2 方案 / penguin 报告 / 重构基线 / 接线策略 / 立项前调研）。
> 性质：决策前调研，未拍板。所有联网结论以文中 URL 为准。

## 1. 主流记忆系统怎么解决"更新"

**写入决策的主流范式**（Mem0 最显式）：LLM 在"候选事实 × 相似旧记忆"上做四选一——ADD / UPDATE / DELETE / NOOP。LangMem 同构（manager 决定 create/update/整合），Letta 是 agent 自编辑（append/replace）。

- Mem0 论文（[arXiv:2504.19413](https://arxiv.org/html/2504.19413v1)）UPDATE 是**整体替换**（新信息量 > 旧值才替换，旧值直接丢）；但文档层已补两道防丢失：**Memory History** 每条记忆变更日志 + 新版管道转 **additive**（"新记忆加入而不覆写或删除既有记忆"，[Memory Operations](https://docs.mem0.ai/core-concepts/memory-operations)）。行业正在从"写入时判对"退向"写入时只追加"。
- 立项前调研（本仓 `product-pivot-landscape.md` §3.2）已记录 mem0 v3 的同一转向：**ADD-only 提取 + 读时消解**（实体链接 + 多信号检索 + 时间排序）——不在写时解决冲突，在读时解决。
- Hermes 的写路径纪律（[官方记忆文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)）：自动拒绝完全重复；replace/remove 用 substring 匹配且**必须唯一命中**（多命中报错）；**staged 写入若目标条目已被改动则拒绝**——即乐观并发控制，与本仓 v1 的 baseline 比对同构。

**防丢失的三派**：失效而非删除（Graphiti）、版本化（Letta MemFS git）、append-only + 读时消解（mem0 v3）。溯源是各家共同件：Graphiti 保留 episode 原文、Mem0 有 History/source、本仓 v1 的 evidence 引用 seq 区间可回放。

## 2. 退役机制的三个流派

| 流派 | 代表 | 做法 | 代价 |
|---|---|---|---|
| **物理删除** | Mem0 管道 DELETE | LLM 判矛盾即删 | 丢历史，判错不可逆（靠 History 兜底） |
| **软失效/时态标记** | Graphiti 双时态边（valid_at/invalid_at）、Mem0 expiration_date、MemOS MemLifecycle（显式遗忘/归档/晋升） | 标记失效保留历史，可查"任意时点为真" | 存储增长，需要"当前有效"视图 |
| **后台合成取代** | ChatGPT Dreaming、Mem0 Dream、Letta sleep-time compute | 后台 agent 策展/合并/取代过时项 | 可审计性受损（Dreaming V3 被批评的点）；需要溯源保底 |

**编码 agent 产品的现实**：没有一家有自动老化。Claude Code"保留到你或 Claude 删除为止"；Hermes 官方无老化（超限报错让 agent 自行合并，建议 >80% 先合并），移植版 pi-hermes-memory 补了时间戳老化 + 7 天失败记忆年龄上限 + auto-consolidation；Cursor 有 **Promote to Rule**（易失记忆经用户晋升为进 git 的版本化规则）。

## 3. 「项目画像」：真空地带

**没有任何主流产品把项目认知做成结构化、动态 schema 的画像对象。** 现状全是散装记忆或静态规则文件：Claude Code（CLAUDE.md 层级 + 四类 auto memory 笔记）、Cursor（Rules + Memories）、Windsurf（rules + Cascade Memories）、Aider（CONVENTIONS.md，纯人工）。

可拼装的组件存在但均未以"项目"为对象：Memobase 的 profile 动态 schema（LLM 驱动合并更新）、A-MEM 的记忆主动进化（新记忆触发邻居改写，[arXiv:2502.12110](https://arxiv.org/abs/2502.12110)）、Cognee 的 repo→知识图谱摄入。学术侧只有 repo-level understanding 一脉，无 project profiling 论文。

**关键洞察：本项目协作体系（AGENTS.md 分层 + HANDOFF 家庭 + ADR 纪律 + 门禁）本身就是一个高度工程化的项目画像**——人工/AI 共同维护、有格式门禁、有冷归档、有机器校验。记忆库再建一份画像会与它职责重叠（违反"决策走 ADR"边界）；记忆库该补的是画像覆盖不了的**人域知识**（协作偏好、环境事实、跨仓库指针）。

## 4. Hermes 自进化（[hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)，5.5k★，MIT）

- **GEPA**（[arXiv:2507.19457](https://arxiv.org/abs/2507.19457)，ICLR'26 Oral）＝反思式提示进化：对轨迹做"为什么失败"的自然语言反思而非只看分数，维护 Pareto 前沿保多样性，比策略梯度 RL 省 ~35× rollout。eval 集来自真实会话库（Claude Code/Copilot/Hermes）或合成。
- **五阶段路线只有 Phase 1（SKILL.md 进化）落地**，tool descriptions / prompt 片段 / tool 代码 / 全自动 pipeline 均为计划中。$2–10/run，纯 API。
- **防改坏四道门**：pytest 100% 通过、尺寸限制（skill ≤15KB、tool 描述 ≤500 字符）、缓存兼容（禁会话中途变更）、语义保持；**全部变更走 PR 人工审批，never direct commit**。回滚靠 git PR 流程本身，无自动回滚。
- 与本仓 penguin 报告结论互证：自进化的可行性在"eval 门禁 + 人工在环"，宣传远大于落地。

## 5. 本地考古：旧项目已经回答过的问题清单

三时代弧线（08 治理 → 09 后台提取 → 10 对话化 → 10-04 收敛）+ 硬数据：

- **后台提取实测**（`2026-10-03-refactor-baseline`）：烧 90% 直调 LLM（410/453）换 20% refinement 产出，**落盘率 2%**（426 判断 8 落地）；治理期 delete 33 vs add 7。
- **B 裁决**（同 ADR）：保留提取内核、废 per-turn 调度，改**时刻驱动**（压缩 / 收尾 drain / goal 受阻 / 手动 wrapup）——比"每回合"与"仅收尾"都好的第三条触发路线，已裁决过。
- **双 owner 问题 09 月就处理过**（`2026-09-24-memory-agent-wiring-policy`）："通用 planner 产生的 memory 编辑会被机械剥离，避免双 owner"——ZCode 的 eligibility 直写跳过是同一个补丁。
- **v1 资产清单**（`design-v1-2026-08-14.md`）：闭集提案工具 + schema 强校验、evidence 引 seq 可回放、expectedOutcome 可证伪、baseline 乐观并发、快照 + 确定性逆操作回滚、审批门禁、rubric 加密。当时自评"存储层已比 ZCode 重"。
- **已被否决**：晋升式退役（记忆不进版本库，升层走用户拍板）；治理三件套捆绑（10-04 拆解）。
- **对照现实**：ZCode 本机实测（2026-10-06，见记忆 `memory-extraction-boundary`）每回合调度 + 合并突发 = 7 天 30 次运行、29 次有写动作、30 次模型请求成本——提取-only（无 review/planner）的经济性远好于旧管道 90/20/2% 的实测（那包含通用管线）。

## 6. DSH 轨迹资产（补遗：本调研最初遗漏，2026-10-06 补）

面向 DSH 的插件有一项 surveyed 系统里只有 Graphiti 部分具备的资产：**事件溯源 + 严格回放的会话轨迹**。旧插件 v0.10.4 源码（`git show v0.10.4`）是 API 消费的完整证明：

- **会话读面**：`ctx.sessionQuery.readSurface(sessionId)` 返回 seq 编号的有序事件流（user/message、assistant/message、tool/call…），zstd JSONL 落盘、可回放——退役/审计决策可以**重放原始事件验证**，"无法伪造"（v1 设计 §5.2）。
- **增量提取已实现**：`turn-snapshot.ts` 的 `seq:<n>` 游标（边界永不回退、按 phase rebase、突发合并）——ZCode 的 MessageId cursor 在 DSH 上有实现先例，不是设想。
- **轨迹内机械过滤已实现**：`containsDirectMemoryWrite` 扫事件流里的记忆写工具调用（= ZCode 的直写跳过）、内部 agent 识别（header.origin）、compaction/start 强制 flush。
- **溯源入库已实现**：条目 metadata 带 `sourceSeqs`（用户原话所在 seq）；refinement 历史是 append-only 且每条带 evidence。
- **完整生命周期当时已闭环**（这是本次补查最重要的发现）：
  - `promotion.ts`——机械晋升门：LLM 提议、代码裁决（绝对路径/session id/`~/.dsh` 引用模式拦截、tokenize 近重复检测、一句话事实拦截）；
  - `consolidate.ts`（`/evolve consolidate`）——两个卫生信号（条目间冲突 conflictHint 戳记 + **零注入 30 天陈旧**）汇成一批**人工批准**的归档编辑：归档保数据（ARCHIVED_AT_KEY）、可 `/evolve unarchive` 恢复、保留全部轨迹（MERGED_FROM_KEY）；**全程零 LLM，代码提议、人裁决，宁漏归不误归**。
- 即：报告第 2 节的"软失效/时态标记"派和第 6 节菜单 B（软失效+用户保洁），本仓在 JSON store 时代**实现过完整版**。它随 10-04 收敛被拆——拆的理由（store 仅 1-4 条、机制交互以删除为主、delete 33 vs add 7）是关于"当时值不值得"，不是关于"设计错了"。**重建时机 = 记忆库长到机制有账可算的那天**，且 md 形态下实现成本远低于当年（无 schema 引擎，frontmatter 戳记 + 卡片展示即可）。

## 7. 综合决策菜单（待拍板）

**不丢（更新语义）**：
- A. 维持现状（就地改文件 + 读时验证）——零机制，但覆盖即丢历史
- B. ~~`.evolve/memory/` 内自建独立 git~~（**2026-10-06 用户否决**：用户环境不能假设装了 git；嵌套 `.git` 与项目 git/IDE 工具链的相互作用不可控）。替代：**快照账本**——`extraction.jsonl` 的 update 记录内嵌 `before`/`after` 全文（记忆文件 1–3KB、约 30 次/周，年增几 MB，带上限轮转），undo = 从账本取 `before` 重写，`jq` 可查；diff 审计与回滚能力由纯 JSONL 承担，零依赖零嵌套。终极兜底是轨迹本身：记忆是会话轨迹的投影，源头 seq 可回放重建——这是 git 都给不了的恢复性质
- C. append-only 事件流 + 读时消解（mem0 v3 路线）——最不丢，但破坏"一事一文"形态，读路径复杂化，不推荐

**不乱记（写入质量）**：
- 已有：指南边界（当轮就写 + 重推导不存 + 决策走 ADR）——`4a1e57d` 刚发，先观察
- 若加提取轨：闭集提案 + manifest 去重 + staged 写入冲突拒绝（Hermes/v1 同款）+ eligibility（ZCode 同款）；触发用 B 裁决的**时刻驱动**而非 per-turn

**退役**：
- A. 现状（读时验证 + 用户手删 + 卡片漂移警告）——与全行业编码 agent 一致
- B. 软失效层：frontmatter `status: superseded` + 指针替代删除；卡片显示陈旧项，用户定期保洁拍板——Graphiti 哲学的 md 化，机制增量小；**且是 v0.10.4 `consolidate.ts` 语义的重建**（conflictHint + 零注入陈旧 + 人工批准批量归档 + 可恢复，实现先例与踩坑都在 git 历史里）
- C. MemOS 式显式生命周期（遗忘/归档/晋升一等机制）——机制重，违反"机制要少"，不推荐
- D. 晋升通道：稳定记忆经用户拍板升入 AGENTS.md（Cursor Promote to Rule 同款）——与"升层走用户拍板"既有原则吻合

## 8. SQLite 可行性 Spike（2026-10-06 实测，二跑修正）

在用户日常运行的 dotnet-desktop 宿主上验证 SQLite 单库方案的运行时前提。

**运行时事实（第一跑测错二进制，用户纠正后核实）**：桌面端**不自带运行时**——引导设计为 `EnsureNode`：确保**系统全局** Node（PATH）可用、无则下载装到系统全局位，已安装产物（`~/.local/share/DeepSeek.Harness.Desktop/`）内无 runtime 目录。源码仓库里的 `resources/runtime/node`（v24.19）是开发残留，非实际运行时。**实际运行时 = 系统 Node v26.8.1**，`node:sqlite`（`DatabaseSync`）免 flag 直接可用——零新依赖，不需要 better-sqlite3 原生编译。

- **逐项验证通过**（在 v26.8.1 上重跑全部特性）：CHECK/STRICT 约束即门禁（非法 type 物理拦截）、事务回滚与提交原子性、WAL 模式、`busy_timeout` 并发配置、`VACUUM INTO` 原子快照。
- **FTS5 中文检索**：默认 unicode61 分词器不吃中文；**trigram 分词器通过**（"等我确认""本地环境"等查询全部命中）——中文全文检索可用。
- **边界**：`node:sqlite` 需 Node ≥ 22.5——宿主引导本身保证全局 Node 就位，版本过老的场景由引导升级覆盖；`node:sqlite` 为同步 API，对本场景（小事务、后台应用）无影响。

**结论：B 方案（SQLite 单库）技术可行，唯一外部前提已消除。2026-10-06 用户拍板采纳 B。** 开发计划见 [`plans/2026-10-06-v0.15-sqlite-memory-store.md`](../plans/2026-10-06-v0.15-sqlite-memory-store.md)。

## 9. 主要来源

Mem0 [论文](https://arxiv.org/html/2504.19413v1) / [operations](https://docs.mem0.ai/core-concepts/memory-operations)；Graphiti [repo](https://github.com/getzep/graphiti)；Letta [memory](https://docs.letta.com/configuration/memory)；LangMem [指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)；Memobase [repo](https://github.com/memodb-io/memobase)；MemOS [arXiv:2507.03724](https://arxiv.org/abs/2507.03724)；A-MEM [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)；Hermes [记忆文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) / [self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) / [GEPA](https://arxiv.org/abs/2507.19457)；pi-hermes-memory [repo](https://github.com/chandra447/pi-hermes-memory)；Claude Code [memory](https://code.claude.com/docs/en/memory)；ChatGPT [memory](https://openai.com/index/memory-and-new-controls-for-chatgpt)。
