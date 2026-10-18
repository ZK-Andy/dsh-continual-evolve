# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-696%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-97%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-92%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-99%25-brightgreen)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的工作区记忆插件：全部记忆住在一个中央 SQLite 库里（`~/.dsh/evolve/memory.db`，按工作区路径行分区），会话开局注入索引，插件的代码是字面意义的**唯一写者**——模型提议，代码门禁后落盘。

## 为什么

Agent 每个会话积累的可复用经验（用户偏好、踩坑教训、项目背景）下个会话就忘。文件夹式 md 记忆让记忆可见，但每条写入都不设防：索引漂移、frontmatter 腐坏、超尺寸膨胀、密钥泄漏——坏写入落地之后才看得见。本插件保留 ZCode 记忆形态（按工作区分区、开局注入索引、类型化记忆），把存储搬进一个所有变更都过机械门禁的数据库。

它还想用数字回答四件事，而不是靠体感：**这个进程跑的是哪一代代码**、**注入的索引到底有没有被读**、**预算是怎么截断的**、**上次改检索之后命中变好还是变坏**。

## 工作原理

1. **开局注入** —— 只注册一个 system-prompt section：本工作区的记忆索引（查库结果，只含钩子，feedback > user > reference，并列时按 id 稳定排序）、库路径、几行指南。该 section 每会话只算一次并逐字节复用，system prompt 稳定、prompt cache 持续命中；空 store 零 token。
2. **预算按 token 算，超了降级而不是丢掉** —— 预算是 token（CJK 按 1.5 token/字估算，其余 4 字符/token）。装不下时分三档：完整钩子行 → 只留 `- [id]` 行 → `（其余 N 条未展开…）` 计数行。被预算裁掉的记忆仍然能靠 `evolve_read` 捞回来，而不是彻底从上下文里消失。
3. **两个工具，一个写者** —— `evolve_write(kind, …)`（create/update/delete，技能另有 `move-to-global`）承接显式的记住/忘掉与规程沉淀：`kind` 取 `memory`/`skill`/`prompt`，每条提案在一个事务内过门禁（id 规范、type 枚举、feedback 的 **Why:**/**How to apply:** 契约、secret 筛查、64KB 正文上限、可选 `corrects` 纠错链、可选 `notWhen` 不适用条件）。`evolve_read(kind, …)` 按 id 取正文、按关键词检索：先按每一组词取 AND（trigram FTS，兜底 LIKE），全空且不止一个词时退回 OR——因为一句自然语言问句不是关键词表；中文长片段先按 3 字窗口展开。按 id 取到的每份正文计一次查阅（存在心跳：只证明被翻过，不证明有用，长期零查阅是删除候选，剪枝仍需人工）。
4. **提案制提取** —— 轨迹到记忆的自动化，全程 `extraction_log` 可对账。每个 `agent/turn-stopping` 调度**该会话自己**的边界，状态按会话隔离（运行中只保留最新边界——合并而非排队；`compaction/start` 与会话收尾触发 drain），**没有空闲计时器**。一次运行读取游标之后的增量，用 FTS 取相似既有记忆喂给一次 LLM 调用，结构化提案过同一套门禁；失败不推游标。贵调用前先过一道便宜预检门（小 verdict）：拒了按 model-skip 消费游标，门不清就 fail-open 透传给贵调用。贵用量与门用量分两列记账，门自己挂了错误原文留在 `cheap_error`。落盘前还有一道**确定性预筛**：正文与既有记忆全等的 `duplicate`、字段没变的 `no-change` 提案不进写门禁，原因落成 `pre-screen: duplicate×N`。
5. **内容质量自进化环** —— 第二条后台自动化，与提取结构上独立（自有提示词、自有日预算、自有 `review_log`、无游标；只共享写门）。便宜门先判某条值不值得细看，批了才跑贵改写，按内容质量打分（记忆：归属 + 准确/可用/可复用/不重复/不过时；技能：触发精度/可执行完备/不重复，其中「可复用」按分区判）并给出改写提案。四个评审岗位各装自己的说明书。失败记错误原文、跑的模型与已烧 token；截断前已完成的 verdict 仍算数，一条 verdict 都没产出的调用留队重试。新写即审；重审事件驱动（新落盘字面相近、`corrects` 指向、用户纠错的 feedback）。两条轨都按会话**当前**模型选择解析路由，共用一套失败纪律：被拒路由（`AUTH`/`NO_ADAPTER`）在变化前不再调用，瞬态故障 0 → 5 分钟 → 15 分钟 → 1 小时 → 6 小时退避。
6. **记忆分层与两级提级** —— L0（跟人走：协作偏好、语言、本机环境事实，住全局分区）与 L1（项目）；L2 会话状态不进库。进 L0 要过**两次独立判定 + 30 天实习**：提取时归属三测全过打 `scope=person`（仍住原分区），评审第二次判定说 promote 才移动；移动是单事务（全局建行 + 项目行归档，永远只有一份 active），带实习期与来源分区，实习行照常注入并标「（试用中）」。到期按**非来源分区**的引用决定转正、退回或隔离。「放错家」有多级正解：该在全局的提级、该进仓库文档的只出建议（卡片标记，插件绝不写你的仓库）、错/过时的隔离、压根不该存在的归档。物理删除永远人工。
7. **自带观测** —— (a) **代际自检**：进程在导入时对自己入口文件取指纹（`codeGeneration`），查询时重读盘面（`diskGeneration`），两者不同即「需重启」。(b) **注入账本**：每会话一行 `injection_log`（索引点名的 id、估算 token，30 天裁剪），卡片显示近 7 天「注入 N 条 / 被读 M 条（X%）」——「被读」= 注入之后正文被按 id 取出过。局限写在明处：它答的是「有没有被读」，不是「回答有没有用上」。(c) **检索评测**：`npm run eval:recall` 在临时库里播种固定记忆与查询，报 hit@1 与 MRR；空 fixture 按设计报红。
8. **回滚靠账本，不靠机制** —— 每次变更落一条带 before/after 快照的行（`extraction_log` / `skill_log` / `review_log`），undo 就是取 before 重写。每次应用后随跑巡检：孤儿 FTS 行清除、含密钥条目隔离（隐藏不删；被隔离技能的物化文件一并撤下）。插件诊断只落 `plugin_log`（宿主 logger 开箱没有 exporter）；四张账本共用一个 30 天窗口按 UTC 日节流裁剪。
9. **卡片：记忆 + 评审设置** —— 挂在官方插件管理的本 bundle 页面（老宿主自动降级为无卡片）。上面的卡片改全局 `review.*`（显式保存；`enabled` 需重启，其余下一轮生效），不跟工作区下拉联动。下面的卡片是只读投影：运行代/盘面代（该重启时标红）、近 7 天注入转化率、工作区下拉（默认选中当前工作区）、搜索、相对更新时间、点击展开正文预览（5 MiB 上限）、巡检异常、技能区（全局行打标记，项目遮蔽全局）与查阅次数。显示名与描述走宿主 `locale/*.json` 通道，样式走宿主主题 token。

记忆类型沿 ZCode 分类法：`user`（画像与环境事实）、`feedback`（被纠正/确认的做法——正文必带 **Why:** 与 **How to apply:**）、`reference`（资源指针）。`notWhen` 是可选的「不适用条件」，随钩子渲染成「（不适用：…）」——**只做提示，不参与检索过滤**。提取边界只收"跟人与环境走的知识"：决策与取舍天然属于仓库，走仓库的 ADR 路线。

旧版 markdown 记忆库（`<workspace>/.evolve/memory/*.md`）在首次接触时无损导入，原目录改名为 `memory-imported-<date>/` 保留——不删不丢。

## 安装

```bash
# 从 npm（安装即激活——自带 bundle patch）
dsh plugin add dsh-continual-evolve

# 或从源码（首次 GitHub 安装需批准 allowBuilds 构建步骤）
dsh plugin add ZK-Andy/dsh-continual-evolve
```

装完或升级后，重启你实际在用的 profile（桌面端，或 `dsh <profile>`）。

## 使用

没有命令。重启后首个会话自动注入索引；跟模型说「记住…」/「忘掉…」，它经 `evolve_write` 过门禁落盘。要把某套做法沉淀成技能，让它存为技能——物化成 `SKILL.md`，重启后 `skill` 工具能发现；说「所有项目都用」，它会搬到全局（项目副本归档）。会话中途写入的记忆下个会话才可见（section 冻结以保 prompt cache）。

装完怎么核验：打开官方插件管理里的本插件页面，第一行就是「运行代 / 盘面代」——两者不同会标红并写明需重启；`plugin_log` 里有同一条 `build-identity`。库依赖 Node ≥ 22.5（`node:sqlite`）；缺失时插件降级为 no-op 并在控制台告警。

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
pnpm test                    # vitest（696 个测试）
pnpm test:coverage           # v8 覆盖率，CI 门禁 91/83
pnpm lint                    # oxlint src test client scripts
pnpm check:docs              # ADR 格式、文档预算、链接、治理、交接
pnpm check:pack              # 发布产物一致性（prepack 也跑）
pnpm eval:recall             # 离线检索基线（fixture 上的 hit@1 / MRR）
```

目录（`src/` 71 个模块，55 个测试文件）：

```
├── src/
│   ├── index.ts            # 注册：config + 宿主形状 + apply 编排
│   ├── assemble.ts         # 通用挂载：工具 + 提取 + 评审 + 自建技能
│   ├── store.ts            # 存储装配：打开/迁移、按 kind 的方法工厂、再导出
│   ├── store-types.ts      # 存储表面（单一 MemoryStore）+ 账本/账户形状
│   ├── data/               # 存储后端：数据库、通用仓储 + 描述器、行/记录形状（单一家）、
│   │                       # secret 筛查、迁移、账本、评审账户、牵连事件、注入账本、巡检
│   ├── services/           # 应用服务：写门禁、提取/评审环、提案预筛、路由解析与失败纪律、
│   │                       # token 预算、代际自检、提取记账与转化统计、传输、裁剪、
│   │                       # md 导入、技能物化、插件日志
│   ├── pages/
│   │   └── memory-card/    # 插件管理页：路由 + 设置 + 挂载 + 提示
│   └── surfaces/           # 表现层：统一 evolve_* 工具、注入（渲染器 + 预算分档）、
│                           # 快照、指南、自建技能 provider
├── client/
│   └── client.js          # 手写客户端 bundle：记忆卡 + 评审设置卡
├── locale/                # 宿主包元数据：双语显示名与描述
├── scripts/               # 门禁（ADR/文档/分层/预算/产物）+ eval:recall
├── test/                  # vitest 套件（55 个文件）
├── lib/                   # 构建输出（tsc）
├── docs/                  # design.md（设计）· FAQ.md（踩坑记录）
└── .agents/               # AI 协作层（AGENTS.md、技能、ADR）
```

## 文档

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md)
- 存储决策：[`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)
- 观测批次：[`.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md`](.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md)

## 许可

MIT。独立项目，与 DeepSeek 官方无关。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
