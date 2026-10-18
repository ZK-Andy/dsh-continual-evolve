# dsh-continual-evolve

<p align="center">
  <b>为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 提供有治理、可自进化的记忆层。</b><br>
  模型提议，代码门禁，一个数据库落盘。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-continual-evolve"><img src="https://img.shields.io/npm/v/dsh-continual-evolve?color=4D6BFE" alt="npm"></a>
  <a href="https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml"><img src="https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node"></a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome DSH plugin"></a>
  <img src="https://img.shields.io/badge/tests-700%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage_statements-97%25-brightgreen" alt="Coverage statements">
  <img src="https://img.shields.io/badge/coverage_branches-92%25-green" alt="Coverage branches">
  <img src="https://img.shields.io/badge/coverage_functions-99%25-brightgreen" alt="Coverage functions">
</p>

<p align="center">中文 | <a href="README.en.md">English</a></p>

全部记忆、技能与提示词补充住在一个中央 SQLite 库里（`~/.dsh/evolve/memory.db`，按工作区路径行分区）。会话开局注入它的索引，而插件的代码是字面意义的**唯一写者**——每条模型提案都要在一个事务内过机械门禁才会落盘。这里没有任何安全属性依赖模型自觉。

## 亮点

- **一个库，一个写者**——全部状态住一个 SQLite 文件；只有插件代码能写它。
- **开局注入索引**——本工作区的钩子作为单个 prompt section 注入，会话内冻结，feedback > user > reference 排序。
- **预算超了降级，不丢条**——CJK 感知的 token 预算（默认 6000）：完整钩子行 → 只留 id 行 → 「其余 N 条」计数行。
- **两个工具**——`evolve_write` 落记忆、技能与提示词补充；`evolve_read` 按 id 取正文、按关键词检索（trigram FTS，CJK 感知）。
- **提案制提取**——按会话隔离的轮级自动化：无空闲计时器、便宜预检门、duplicate/no-change 预筛，每次跳过都记账。
- **内容质量自进化环**——自有提示词、预算与账本；判词为改写／隔离／归档／仅建议；删除永不自动；默认试运行。
- **记忆分层**——L0 跟人走，L1 跟项目走，L2 不进库；L0 只能经两次独立判定 + 30 天实习进入。
- **观测是读数，不是体感**——代际自检、近 7 天注入→被读转化率、离线检索基线。
- **回滚靠账本**——每次变更都留 before/after 快照，外加孤儿索引行与含密钥条目的巡检。
- **插件管理卡片**——只读的库投影（搜索、预览）与全局 `review.*` 设置卡。

## 快速开始

```bash
# 从 npm（安装即激活——自带 bundle patch）
dsh plugin add dsh-continual-evolve

# 或从源码（首次 GitHub 安装需批准 allowBuilds 构建步骤）
dsh plugin add ZK-Andy/dsh-continual-evolve
```

装完或升级后，重启你实际在用的 profile（桌面端，或 `dsh <profile>`）。需要 Node ≥ 22.5（`node:sqlite`）；缺失时插件降级为 no-op 并在控制台告警。

没有命令要记——直接说：

```text
「记住我做 review 用 oxlint，不用 eslint」  → evolve_write，过门禁落盘
「把这套做法存成技能」                        → 物化成 SKILL.md，重启后 skill 工具能发现
「所有项目都用」                              → 技能搬到全局分区
```

> [!TIP]
> 重启后打开插件管理里的本插件页面：第一行对比「运行代 / 盘面代」，两者不同会标红并写明需重启；`plugin_log` 里有同一条 `build-identity`。

会话中途写入的记忆下个会话才可见——注入的 section 冻结以保 prompt cache。

## 工作原理

```
  输入  ──  「记住…」(evolve_write)  ·  会话轮次 (提取)
  门禁  ──  id 规范 · type · secret 筛查 · 64KB 上限 · Why/How 契约 · 单事务
  存储  ──  memory.db，按工作区行分区
  出口  ──  下个会话注入索引  ·  评审环（改写 / 隔离 / 归档）
```

### 开局注入

- 只注册一个 system-prompt section（`order 400`）：本工作区的索引，只含钩子（id、标题、描述截 20 字、可选「不适用」）；类型不逐行标注，由块内 feedback > user > reference 排序承担。外加库路径与两段指南，并列按 id 稳定。
- 每会话只算一次并逐字节复用——prompt cache 持续命中；空 store 零 token。
- 预算按 token 计，CJK 感知（中文 1.5 token/字，其余 4 字符/token）。装不下分三档降级：完整钩子行 → 只留 `- [id]` 行 → `（其余 N 条未展开…）` 计数行。被裁掉的记忆仍能靠 `evolve_read` 捞回。

### 唯一写路径

- `evolve_write(kind, …)` 承接 `create` / `update` / `delete`（`kind = memory | skill | prompt`），技能另有 `move-to-global`。
- 门禁在一个事务内完成：id 规范、type 枚举、feedback 的 **Why:**/**How to apply:** 契约、secret 筛查、64KB 正文上限、可选 `corrects` 纠错链、可选 `notWhen` 不适用条件。
- `evolve_read(kind, …)` 按 id 取正文、按关键词检索：先按词组取 AND（trigram FTS，兜底 LIKE），再退 OR，中文片段按 3 字窗口展开。
- 按 id 取到的每份正文计一次查阅——这是存在心跳，不是有用证明。长期零查阅是删除候选，但剪枝始终人工。

### 提取

轨迹到记忆的那条轨，全程 `extraction_log` 可对账。

- 轮级且**按会话隔离**：`agent/turn-stopping` 调度该会话自己的边界，运行中只保留最新边界（合并，不排队）；`compaction/start` 与会话收尾触发 drain。**没有空闲计时器。**
- 一次运行读取游标之后的增量，过一道便宜预检门，用 FTS 取相似既有记忆作上下文，一次 LLM 调用的提案过同一套门禁。预检拒绝按 model-skip 消费增量；门不清则 fail-open 透传。
- 落盘前有**确定性预筛**：与既有正文全等的 `duplicate`、字段没变的 `no-change` 不进写门禁（原因落成 `pre-screen: duplicate×N`）。失败不推游标；每次跳过都记账。

### 质量评审

第二条后台轨，结构上独立：自有提示词、自有日预算（默认 100 条）、自有 `review_log`、无游标——只共享写门禁。

- 便宜门先判某条值不值得细看，批了才跑贵改写。
- 贵改写按内容质量打分并给出改写提案——记忆看归属 + 准确/可用/可复用/不重复/不过时；技能看触发精度/可执行完备/不重复，其中「可复用」按分区判。
- 判词四个出口：改写 · 隔离（隐藏、永不删除）· 归档（保留历史、不再注入）· 仅建议「这条该进仓库文档」。插件绝不写你的仓库。
- 新写即审，重审由事件驱动；日历只是兜底抽样（`review.staleDays` 是「最长免审期」，连续 keep 使其翻倍）。默认试运行。

### 分层与提级

- L0（跟人走，住全局分区）· L1（跟项目走）· L2（会话/任务状态，不进库）。
- L0 不是手工维护的分区。进 L0 要过**两次独立判定 + 30 天实习**：提取时打 `scope=person`，评审第二次判定说 promote 才移动。
- 移动是单事务——全局建行、项目行归档，永远只有一份 active——带实习期与来源分区。
- 实习行照常注入并标「（试用中）」；到期按非来源分区的引用转正、退回或隔离。物理删除永远人工。

### 回滚、巡检、观测

- 每次变更落一条带 before/after 快照的行（`extraction_log`、`skill_log`、`review_log`），undo 就是取 before 重写。四张账本共用一个 30 天窗口按 UTC 日节流裁剪。
- 每次应用后随跑巡检：孤儿 FTS 行清除、含密钥条目隔离（隐藏不删；被隔离技能的物化文件一并撤下，不再加载）、漂移的技能文件按库重写。
- 诊断只落 `plugin_log`——宿主 logger 开箱没有 exporter。
- 三件事从体感变读数：**代际自检**（导入时对入口文件取指纹、查询时重读盘面，不同即「需重启」）· **注入账本**（`injection_log`，近 7 天「注入 N 条 / 被读 M 条」——答「有没有被读」，不答「回答有没有用上」）· **检索评测**（`npm run eval:recall` 报 hit@1 与 MRR；空 fixture 按设计报红）。

### 卡片

- 挂在官方插件管理的本 bundle 页面；老宿主自动降级为无卡片。
- 上面的卡片：全局 `review.*`——显式保存；`enabled` 需重启，其余下一轮生效。
- 下面的卡片：只读投影——运行代/盘面代、近 7 天注入转化率、工作区下拉（= 库内分区）、搜索、相对更新时间、点击展开正文预览（5 MiB 上限）、巡检异常、技能区（全局行打标记，项目遮蔽全局）与查阅次数。

类型沿 ZCode 分类法：`user`（画像与环境事实）、`feedback`（被纠正/确认的做法——正文必带 **Why:** 与 **How to apply:**）、`reference`（资源指针）。`notWhen` 是可选的「不适用条件」，随钩子渲染成「（不适用：…）」——只做提示，不参与检索过滤。提取边界：只收跟人与环境走的知识；决策与取舍天然属于仓库，走仓库的 ADR 路线。旧版 markdown 记忆库（`<workspace>/.evolve/memory/*.md`）首次接触时无损导入，原目录改名为 `memory-imported-<date>/` 保留——不删不丢。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 注册记忆 section |
| `memoryIndex.guide` | `true` | 注入指南（关闭且索引为空时零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxTokens` | `6000` | 注入索引的硬 token 预算（CJK 感知；超预算的行降级为 id 行） |
| `memoryIndex.extraction` | `true` | 提案制提取运行（轮级、按会话分槽、无空闲计时器） |
| `review.enabled` | `true` | 内容质量自进化环（自有提示词/预算/账本，默认试运行） |
| `review.dryRun` | `true` | 只记 verdict 不落盘 |
| `review.dailyBudget` | `100` | 每 UTC 日最多审几条（新写 > 牵连/时钟 > 抽样，按来源分列计数） |
| `review.batchSize` | `10` | 单次 drain 最多审几条 |
| `review.staleDays` | `30` | 最长免审期：过了才有资格被抽样；连续 keep 使其翻倍（30→60→120，封顶） |
| `memoryCard.enabled` | `true` | 插件管理里的记忆卡 + 评审设置卡 |

`memoryIndex.maxChars`（0.19 之前的字符预算）只被读**一次**：首次读取时折算成 token（`floor(chars / 1.5)`）并记入库，此后 token 键是唯一活源。

`review.*` 全部 volatile：设置卡改了不必重挂，调度器每轮重新读值。

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxTokens: 8000
      extraction: true
    review:
      dryRun: false
```

## 开发

```bash
pnpm install && pnpm build   # 装依赖 + 干净构建 -> lib/
pnpm test                    # vitest（700 个测试）
pnpm test:coverage           # v8 覆盖率，CI 门禁 91/83
pnpm lint                    # oxlint src test client scripts
pnpm check:docs              # ADR 格式、文档预算、链接、治理、交接
pnpm check:pack              # 发布产物一致性（prepack 也跑）
pnpm eval:recall             # 离线检索基线（fixture 上的 hit@1 / MRR）
```

| 路径 | 内容 |
|---|---|
| `src/` | 71 个模块：注册、存储、`data/` 后端、`services/` 应用服务、`surfaces/` 表现层、`pages/memory-card/` |
| `client/` | 手写客户端 bundle（记忆卡 + 评审设置卡） |
| `locale/` | 双语显示名与描述（zh/en） |
| `scripts/` | 门禁（ADR/文档/分层/预算/产物）+ `eval:recall` |
| `test/` | vitest 套件，55 个文件 |
| `docs/` | `design.md`（设计）· `FAQ.md`（踩坑记录） |
| `.agents/` | AI 协作层（AGENTS.md、技能、ADR） |

## 文档

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md)
- 存储决策：[`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)
- 观测批次：[`.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md`](.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md)

## 许可

MIT。独立项目，与 DeepSeek 官方无关。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
