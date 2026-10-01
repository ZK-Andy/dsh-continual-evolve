# Agent Note: evolve v2 被动读路径 + 低摩擦写路径

Status: implemented

## Problem

治理层（版本/回滚/门禁/审计/benchmark）领先业界，但记忆的**读**与**写**两头都靠模型自觉，体感落后对照物 ZCode：

- **读**：记忆库在 `~/.dsh/evolve/`（workspace sandbox 之外），模型 read 工具读不到；现有注入只给 `- [memory:type:id] title` 一行索引（`inject.ts` directory），要看全文得再调一次 `evolve_recall`。ZCode 是开场就把事实正文摆在上下文里，无需检索即用。
- **写**：唯一沉淀路径是后台 Memory Agent 流水线，默认关（`autoReview` 默认 false）、且 09-26 起因快照门禁 `settings` 解析缺陷静默停摆过（v0.10.4 才修）；token 账 09-25 单日 104 次调用 / 20.5 万 token，memory 占 85%。主会话手里没有"何时该存"的指南全文。
- 方案全文（含 when_to_save 指南原文）：`docs/research/evolve-v2-passive-read-write-plan.md`。

## Decision

三段改动同变更落地，全部集中在本插件仓库，存储层不动。

**一、开场注入记忆索引 section（读路径）**
- 新增 `src/memory-index.ts`，注册第三个 section：`name: "evolve:memory-index"`、`order` 默认 400（配置 `memoryIndex.order`）。
- 位置依据（本次实测上游 `@deepseek-ai/dsh-system-prompt`）：`SECTION_ORDERS` 为 `HARNESS_IDENTITY:-1000 → DEPLOYMENT_PERSONA_PREFIX:0 → PLAN_POLICY:500`，**1–499 全为空档**，故现有 118/119（`index.ts` 的两段 `tool:continual-evolve*`）与 400 不争命名槽位；排序为 `a.order - b.order || compareNames(name)`，同序按名字字典序，两者共存安全；section 名重复会 fail-loud 抛错（`already registered`），新名 `evolve:memory-index` 未占用。
- **会话内冻结**：`createFrozenMemorySection()` 按 `agent.id` 记忆构建结果，会话第一次装配算一次，之后逐字节复用 → system prompt 整场稳定，保 prompt cache（当前 `cacheWrite=0`、cacheRead 命中的健康状态）；新记忆下个会话生效，即时可见性由 `evolve_recall` 兜底。缓存有界（默认 32 会话，LRU 淘汰）。
- **注入内容而非路径**：每条记忆正文直接进 section（ZCode 的给路径做法在本 harness 不可行，见 Alternatives）。
- **预算与降级**：`memoryIndex.maxChars` 默认 6000，硬上限。排序按记忆类型 `project > feedback > user > reference`，同级按 recency，再按稳定字典序；排序后逐条吃预算写**全文**，放不下的降级为一行索引（`directoryLine`：id + title hook），索引行同样吃预算，最后附 `evolve_recall` 提示与省略计数（`- …and N more memories`）。
- 注入同时记 usage（`recordInjection`，按会话去重），沿用既有 OBSERVATION 度量口径。

**二、when_to_save 指南全文（写路径的隐藏主力）**
- 新增 `src/memory-guide.ts`：方案 §改动二的中文全文，含四类 `when_to_save`/`how_to_use`/`body_structure`、确认信号与纠错信号并列、`description` 即未来相关性 hook、以及"主会话内直接用 `evolve_add` 落盘，不必等后台流程"的点名授权。
- 指南是 section 的固定组成部分，**空 store 也注入**（否则新装永远学不会写）；`memoryIndex.guide` 可关，关掉且无记忆时 section 渲染为 `""` 被渲染器丢弃，"空 store 零 token"性质保留。
- 指南中文单语（与用户记忆正文中文一致）；英文对照版延后（见 Consequences）。

**三、写路径降摩擦**
- section 内点名授权主会话直写 `evolve_add`（上一段）。
- 后台流水线**维持默认关**：`autoReview` 默认 false，`/evolve pause|resume` 经 `evolve/runtime.json` 拥有开关，Memory Agent listener 常驻注册只为免 profile 编辑。即方案要求的"可选、默认 off"已成立，不新增冗余开关。
- 六个工具 description 瘦身对冲 section 的净增：实测基线（`registerEvolveTools` 后 `JSON.stringify`）合计 **6206 字符**，其中 `evolve_add` **1798**、`evolve_recall` 1175、`evolve_delete` 1096、`evolve_update` 914、`evolve_rollback` 695、`evolve_list` 528；瘦身后 **5181**（`evolve_add` 1420、`evolve_recall` 1050、`evolve_update` 842、`evolve_delete` 839、`evolve_rollback` 611、`evolve_list` 419），**−1025 字符 / −16.5%**。方案原估"砍一半"实测达不到：剩余 86% 是工具 API 必需的结构化 JSON（enum/required/output schema），不是文案（见 Consequences）。

**四、去重**：`entriesSectionText` 在 v2 开启时不再把 memory 列进 entry directory（memory 的展示家移到新 section），避免同一批记忆两处烧 token；usage 记账随之只由新 section 承担。

## Alternatives considered

- **照抄 ZCode：给记忆库文件路径让模型自己 read**：记忆库在 `~/.dsh/evolve/`，位于 workspace sandbox 之外，模型 read 工具读不到（本 harness 已用真实路径验证过），拒绝。改为正文直灌。
- **每轮装配重算记忆块（跟着最新相关性走）**：system prompt 每轮变化即破 prompt cache，用户当前健康态是 cacheWrite=0/命中 cacheRead，成本远大于收益，拒绝。会话级冻结 + `evolve_recall` 兜底。
- **在 `apply()` 里算一次（进程级）**：一个进程可能承载多个会话，进程级缓存会把 A 会话的记忆串进 B 会话，拒绝。按 `agent.id` 冻结。
- **指南等有记忆了再注入**：新装/清空后模型没有"何时该存"的指南，写路径永远起不来，与本方案目标相反，拒绝。改为独立 `guide` 开关 + 空 store 也注入（可关）。
- **新 section 与旧 directory 并存、memory 两处都列**：同一批记忆的标题与正文双花 token，正是本方案要压的成本，拒绝。目录不再列 memory。
- **把预算做大（如 20k）**：中文 ≈1 token/字符，20k 字符即 20k token 量级，超出方案 6k 的拍板口径，拒绝。默认 6000 + 可配置。
- **顺手把后台流水线默认打开**：token 账显示 memory 占 85% 且曾静默停摆，先靠主路径直写降摩擦，后台维持用户显式开启，拒绝。
- **同步出英文指南**：本期只做中文（用户记忆正文即中文），英文版延后避免双语配对机制拖大变更面。
- **只做改动一（读路径）**：读路径注入的成本必须由写路径的产出兑现，且方案拍板"三项全做"，拒绝拆分。

## Consequences

- **token 成本（必须盯着）**：section 上限 6000 字符，中文按 ≈1 token/字符约 3–6k token/请求；工具 schema 瘦身只回收 1025 字符（≈0.3–0.5k token）——**净增真实存在，方案"砍一半正好对冲"的估算实测不成立**（结构 JSON 占 86%，见 Decision §三）。故 `maxChars`/`order`/`enabled`/`guide` 全进 schemastery 配置，随时可降；冻结机制保证缓存命中后重复请求只付 cacheRead。
- **观测重点**：上线后先看 `token-usage.jsonl` 与 projcache 的 `systemTokens`/`cacheWrite`，确认净增落在可接受区间；超预期就下调 `memoryIndex.maxChars`（配置改动，无需发版语义变更）。
- **生效时机**：记忆块"本会话冻结"是设计属性不是缺陷——写入的记忆下个会话自动带上；本会话内仍可 `evolve_recall` 即时取回。
- **观测**：OBSERVATION.md 既有第 ④ 项（注入"懂你"度）与第 ③ 项（token 成本）直接受益；新增评估点——"该记住的东西第二个会话是否自动生效"（方案 §验收 3，唯一在意的验收标准）。
- **验收（方案 §验收）**：①快照测试断言 section 存在且同会话两次装配逐字节一致；②上线后查 `contextBreakdown.systemTokens` 与 `cacheWrite`（应仍为 0）；③A/B 体感。
- **测试**：新增 `test/memory-index.test.ts` 覆盖类型优先级、预算降级、索引省略计数、冻结缓存命中/淘汰、空 store 与 guide 开关、usage 记账；`inject.test.ts` 补目录不列 memory 的回归。
- **延后项**：英文指南对照版；`metadata.lang` 检测仍 deferred（既有笔记）。
