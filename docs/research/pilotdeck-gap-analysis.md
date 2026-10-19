# PilotDeck 2.0 差距分析（记忆机制对照）

> 2026-10-19 调研。对象：[OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck)（AGPL-3.0）记忆核心 `edgeclaw-memory-core`。
> **AGPL-3.0 约束：只借鉴设计，任何代码不得进入本仓库（MIT）。** 本文引用的 `src/...` 路径均为上游仓库路径，非本仓库文件。

## 1. 调研范围与方法

- 六步配方：`gh` 发现与验真 → 稀疏克隆（`--depth 1 --filter=blob:none`，仅 `src/context/memory` + `docs`）→ 三路并行全文精读。
- 精读对象（共 15.4k 行 TS）：`storage/sqlite.ts`(1984)、`core/types.ts`(720)、`core/file-memory.ts`(1611)、`core/retrieval/reasoning-loop.ts`(799)、`core/pipeline/heartbeat.ts`(1017)、`core/review/dream-review.ts`(1492)、`core/skills/llm-extraction.ts`(3616)、`service.ts`(1149)、集成层 `EdgeClawMemoryProvider.ts` / `MemoryAttachmentBuilder.ts` / `MemoryResolver.ts`。
- 全程只读，未修改任何文件；结论以源码行为准，README 营销数据不作为依据。

## 2. 项目画像与健康度

| 项 | 值 |
|---|---|
| 仓库 | OpenBMB/PilotDeck，创建 2026-05-22，最近 push 2026-10-18 |
| 出身 | 清华 THUNLP + ModelBest（面壁）+ OpenBMB + AI9Stars |
| 数据 | 4,712 star / 513 fork（10.9%）/ 14 位贡献者 / open issues 158 |
| 版本 | 日期制 Release，最新 `v2026.10.17`；README 宣布 2026-10-15 发布 **2.0**（无 `v2.0` tag） |
| 定位 | 以 WorkSpace 为单位的 agent 操作系统，三支柱：白盒记忆 / 智能路由 / Always-on，MCP 原生 |
| 许可 | **AGPL-3.0**（核心 `edgeclaw-memory-core` 为私有包，未发 npm） |

## 3. 机制拆解

### 3.1 存储与条目模型

- **文件即真相**：markdown + frontmatter 是唯一记忆载体；SQLite（`control.sqlite`）只存原始会话 `l0_sessions` 与运行态 KV `pipeline_state`，**全包仅 2 张表**，无 FTS、无触发器、无外键、无审计表。
- **零 SQL 事务**：全文件无 BEGIN/COMMIT；跨步一致性靠文件层 staging+backup-swap（`replaceDirectoryWithStaged`），Windows EPERM 退化为 cp+rm，部分失败用 fallbackSnapshot 重建回滚。
- **审计塞 KV**：index/dream/case 三类 trace 以 JSON 数组存 pipeline_state，去重排序后 `slice(0,30)` 截断。
- **检索**：无 FTS；目录全量扫 + 子串匹配 name/description/path，无缓存索引。
- **条目字段**（frontmatter）：`type=user|feedback|project|general_project_meta`、`scope=global|project`、`capturedAt`、`sourceSessionKey`（来源会话引用）、`dreamUpdatedAt`/`dreamAttempts`（整理痕迹）、`deprecated`（软删除）、跨工作区镜像三字段。**没有** TTL、`notWhen`、`probation_until`、版本链；`FactCandidate.confidence` 只在候选层、不落条目。
- 导出为版本化 bundle（`clawxmemory-memory-snapshot.v4`），导入前校验拒绝 `..` / 绝对路径 / 重复路径，写入后二次校验。

### 3.2 检索、心跳与 Dream 巩固

- **检索**（`ReasoningRetriever.retrieve`）为线性 3 段 LLM 管道、0 轮迭代重排：Memory Gate 路由（失败回退 `none` 不注入）→ general 模式项目消歧（本地打分 `exact*10+token`、CJK 2/3-gram、top30 → LLM 选一，失败回退本地最高分）→ manifest ≤200 条 → LLM 选 ≤5 文件 → 每文件 200 行拼块。缓存 TTL 30s，key 含 snapshot 版本，写后主动失效。
- **心跳索引**：积压 ≥20 轮 **或** 距锚点 ≥30min 触发；`hasNewContent` 逐条比对 + 公共前缀增量合并去抖；只把 user 轮当焦点；失败 session 不推游标（at-least-once），锚点丢失从最早 pending 重建。
- **Dream 巩固**：`changedFilesSinceLastDream > 0` 且超 60min 才跑（零变化清锚点不烧 LLM）；**在 staged 副本上执行**，成功才安装快照，可 `rollbackLastDream`。
- **防幻觉三板斧**：`validateExclusiveClusters` 机械校验（成员白名单、簇 ≥2 且 ≤8 文件、簇间互斥、"泛化理由"正则命中整簇丢弃）；条件删除（新内容 body 真变才删源，LLM 失败绝不删）；吸收窗口预算（≤200 文件 / ≤120,000 字符，受保护路径永不吸收）。

### 3.3 提取与注入

- **两段式提取**：`MEMORY_CLASSIFICATION_SYSTEM_PROMPT` 只分类不写记忆，强制带 `evidence` 原文引用；分类结果作为先验进入生成 prompt。边界三测试：**Identity**（user 须是描述人本身）/ **Override**（他项目可覆盖的规则→feedback）/ **Output**（约束回复格式与交付物→feedback）。
- **代码层白名单**：LLM 输出的 id 一律与允许集求交、越界即丢；通用名过滤；feedback 段落黑名单去复读；全字段截断（name80/desc180/rule220/content280）。
- **降级方向一律「宁可不记不乱记」**：分类失败→不写、路由失败→`none`、选择失败→确定性兜底、提取失败→空集。
- **留痕三层**：debugTrace（systemPrompt/userPrompt/rawResponse/parsedResult/errored/timedOut）、decisionTrace（含 discarded 逐条 reason）、caseTrace（query / intent / 注入预览 / 最终回复配对落库）。
- **注入**：每轮 turn-start 现场检索，产出 `<memory-context>` 单条 user 消息；同一 Builder 亦用于**压缩后重注入**；失败降级为 diagnostics（severity=warning）不打断主链路；召回内容重组四段（User Profile / Project Meta / Project Memory / Feedback Memory）并声明「与本轮用户显式指令冲突以本轮为准」。
- **无召回率计算**：grep 无 recallRate/hitRate，度量数据（caseTrace）已具备、指标待做——与本插件现状同起跑线。

## 4. 能力矩阵（PilotDeck vs 本插件）

| 能力 | PilotDeck | dsh-continual-evolve |
|---|---|---|
| 真相存储 | 文件即真相，SQLite 只存会话与 KV | SQLite 单库是唯一真相，md 只读投影 |
| 检索 | 目录全量扫 + 子串，LLM 选文件 | FTS5 关键词 + 概率兜底 |
| 事务 | 无 SQL 事务，文件层 swap | 单库事务（提级/评审同事务） |
| 审计 | KV 截断 30 条 + 三层 trace | 专表（item_events / extraction_log / injection_log / review_log） |
| 分层治理 | global/project 双作用域 | scope + 30 天实习提级 + verdict 八值 + 归档门槛 |
| 负条件 | 无 | `notWhen` |
| 注入 | 每轮检索 + 压缩后重注入，四段分层 | 会话冻结索引，行级平铺，token 三档降级 |
| 提取 | 两段式分类→生成，evidence 引用 | 单 prompt 提案 + 预筛 + 门禁 |
| 误删保护 | 软删 + 恢复 + staged 快照回滚 | 硬删；批量改写无回滚 |
| 提案校验 | 代码层机械校验 + droppedWarnings | 提示词约束为主，缺代码级拒因账本 |
| 评审节流 | changed-since-last > 0 才跑 | 三档队列，缺零变化硬门槛 |

## 5. 差距分析与借鉴清单

### 5.1 挂进既有待办（零新计划）

1. **caseTrace 配对落库**（`EdgeClawMemoryProvider.ts:209-236`）→ 记忆召回度量的前置数据形状：记 query/注入预览/回复，离线算命中率、零在线开销。
2. **被拒候选逐条记 reason**（`llm-extraction.ts:3302-3571`）→ 本插件门禁只有过/拒两态；有拒因分布才能调参，归门禁缺口批次 A（G3 红绿俱验）。
3. **LLM 提案机械合法性校验**（`dream-review.ts:331-433`、id 白名单求交 `:1436`/`:2982`）→ verdict/提案落地前补代码级门禁，丢弃入 `droppedWarnings`；归门禁批次 A / RSI 判据。
4. **注入分层四段 + 冲突守则**（`service.ts:501-528`）→ 开局注入加分层标题与「与本轮指令冲突以本轮为准」，提示词两行、成本极低。
5. **「无变化不跑」硬门槛 + 双阈值锚点**（`service.ts:719-722`、`952-961`）→ 评审队列加 changed-since-last>0 门槛，直接压 LLM 调用。
6. **软删除 + 恢复**（`file-memory.ts:1258`/`1278`）→ 与归档可见性待办配套：`deleted_at` + 恢复入口，一个改动覆盖两件事。
7. **两段式分类→生成 + Identity/Override/Output 三测试**（`llm-extraction.ts:218`/`:2552`）→ 解决单 prompt 下 user/feedback 边界混淆，分类强制 evidence 原文引用。

### 5.2 需单独立项（有增量，要花预算）

1. staged 演练 + before/after 快照 + 一键回滚（`service.ts:806-857`/`881`）：提级、归档、批量合并不再直改活库。
2. 条件删除 + 吸收窗口预算（`dream-review.ts:1304-1325`、`:435-459`）：内容真变才删源，合并设条数/字符上限。
3. 来源引用同源去重（`sourceSessionKey`+`capturedAt`，`sameOrigin:497`）：同会话重复提取 upsert 而非新增。
4. promptDebug 可回放（`types.ts:427`）：审计补 prompt_json 列，回答「为什么抽出这条」。
5. 压缩后记忆重注入（`MemoryAttachmentBuilder.ts:19-20`）：长会话 compact 后记忆接回上下文。
6. 每轮检索 vs 会话冻结：架构级分叉，牵动召回度量设计——先攒数据再决定。

### 5.3 明确不做

- **网络失败自动重试 3 次指数退避**（`llm-extraction.ts:2363-2387`）：与「网关不稳即失败上报」的既有立场相悖。
- **存储 / 检索 / 审计三块**：2 表、零事务、无 FTS、KV 截断审计，照搬是倒退。
- **任何代码复用**：AGPL-3.0 传染本仓库 MIT 许可。

## 6. 结论

PilotDeck 与本插件撞的是产品主张（白盒记忆、工作区隔离），其产品化与叙事更成熟，但底层机制密度低于本插件（无事务、无分层提级实习、无负条件、审计 KV 截断）。本插件的真实差距集中在两处：**可观测粒度**（逐条拒因、分步 trace、可回放 prompt、召回数据配对）与**误删保护**（软删、staged 回滚）。第 5.1 节七条全部在补这两块，无一条要求推翻现有设计。
