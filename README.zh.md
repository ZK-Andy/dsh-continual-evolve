# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-512%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-96%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-90%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的工作区记忆插件：全部记忆住在一个中央 SQLite 库里（`~/.dsh/evolve/memory.db`，按工作区路径行分区），会话开局注入索引，插件的代码是字面意义的**唯一写者**——模型提议，代码门禁后落盘。

## 为什么

Agent 每个会话积累的可复用经验（用户偏好、踩坑教训、项目背景）下个会话就忘。文件夹式的 md 记忆让记忆可见，但每一条写入都不设防：索引漂移、frontmatter 腐坏、超尺寸膨胀、密钥泄漏——坏写入落地之后才可见。本插件保留 ZCode 记忆形态（按工作区分区、开局注入索引、类型化记忆），把存储搬进一个所有变更都过机械门禁的数据库。

## 工作原理

1. **开局注入** —— 插件只注册一个 system-prompt section：注入本工作区的记忆索引（查库结果，只含钩子，超预算按整行截断，feedback > user > reference 排序）、中央库路径、三行指南。该 section 每会话只算一次并逐字节复用，system prompt 稳定、prompt cache 持续命中；空 store 零 token。
2. **两个工具，一个写者** —— `evolve_write(kind, …)`（create/update/delete，技能另有显式 `move-to-global`）承接显式的记住/忘掉与可复用操作规程的沉淀：`kind` 取 `memory`、`skill`、`prompt`，每条提案过代码门禁（id 规范、type 枚举、feedback 的 Why/How 契约、v1 移植的 secret 筛查、64KB 正文上限、可选 `corrects` 指向被替代的同工作区 active 记忆）后在一个事务内落盘。`evolve_read(kind, …)` 按 id 取正文、按关键词检索——空格分隔的关键词取 AND，短词与 trigram 未命中时回退字面子串匹配；注入索引只有钩子。按 id 取到的每份正文计一次查阅（查阅次数 + 上次查阅，卡片展示）。这是存在心跳——只证明被翻过，不证明有用：长期零查阅是删除候选，剪枝拍板仍需人工。技能走同一套纪律（短横线 id、secret 筛查、64KB 上限、跨范围禁重名重文）；每条落地的技能由插件代码物化为 `<workspace>/.agents/skills/<id>/SKILL.md`——库是唯一真相，文件是只读投影，漂移由巡检按库还原，同名时项目遮蔽全局。宿主没有工具服务时降级为告诉用户措辞，注入不受影响。
3. **提案制提取** —— 轨迹到记忆的自动化，全程 `extraction_log` 可对账：每个 `agent/turn-stopping` 调度**该会话自己**的边界，状态按会话隔离（运行中只保留最新边界——合并而非排队；`compaction/start` 与会话收尾触发 drain），**没有空闲计时器**。一次运行读取该会话游标之后的轨迹增量，用 FTS 取相似既有记忆喂给一次 LLM 调用，模型的结构化提案过同一套门禁落盘；失败与被拒不推游标，下次触发重试。贵调用之前先过一道便宜预检门（增量前 4KB + 归属三测，小 verdict）：拒了直接按 model-skip 消费游标，不烧全量 prompt；门不清不楚就透传给贵调用——最差退化成老单调用，永不 stall。贵用量与门用量分 `usage` / `cheap_usage` 两列记账；门自己挂了按 fail-open 透传，错误原文留在同一行的 `cheap_error`——门死了与门不存在可区分。内部 agent、空增量、无真实用户文本的轮次、当轮已有显式 `evolve_write` 的轮次机械跳过——每次跳过都记账，同一会话连续的空转轮次合成一行并累计唤醒次数。
4. **内容质量自进化环** —— 第二条后台自动化，与提取在结构上独立（自有提示词、自有日预算、自有 `review_log` 账本、无游标；只共享库的写门）：便宜门模型先判某条记忆/技能值不值得细看，批了才跑贵改写，按内容质量打分（记忆：归属 + 准确/可用/可复用/不重复/不过时五维；技能：归属 + 触发精度/可执行完备/不重复三维，其中「可复用」按分区判——项目分区技能只按该项目内跨任务可用判，跨项目可用只对全局分区技能判，绑定本仓库路径/门禁的项目技能不算缺陷）并给出改写提案。四个评审岗位（记忆/技能 × 门/昂贵门）从同一张子代理定义表各装自己的说明书——一份提示词服务不了两者：记忆要求抹掉仓库名仍成立，项目技能本来就该绑仓库。同一套归属三测（主语是用户/环境还是某仓库的某版机制、去名后还成立吗、仓库事实住 ADR/docs）也守在提取 prompt 门口，版本细节从源头就不进记忆；评审调用失败记错误原文，不记秃码，并连同它跑在哪个模型、已烧掉多少 token 一并落账；门自身预算取自模型自己广告的输出上限而非固定值——截断前已完成解析的 verdict 仍算数，而一条 verdict 都没产出的调用（路由故障、预算截断）不让条目记为已评审，而是留队重试。新写即审、存量走有界积压队列排空、长期未动 30 天回炉。两条硬保证框住自动化：删除永不自动落盘（只有改写与隔离——隔离隐藏不删），超幅改写自动转隔离。日上限默认 100 条（新写 > 被纠正牵连 > 陈旧 > 抽查，尾部丢弃不滚雪球）框住 token 开销；每条终态落一行 `item-review` verdict 行、每天合一行日 rollup（预算 vs 实审 vs 积压 vs 丢弃，token 按便宜/贵分账），方便以后复盘。默认试运行（`review.dryRun` 开）：只记 verdict 不落盘，且未落盘的拟改稿全文随行进 `proposed` 列——试运行要看的是「改成什么样」，不只是「为什么改」。
5. **回滚靠账本，不靠机制** —— 每次变更落一条带 before/after 全文快照的 `extraction_log` 行；undo 就是取 before 重写。技能变更同样落 `skill_log`，评审 verdict 落 `review_log`。每次应用后随跑一次巡检：孤儿 FTS 行清除、含密钥条目隔离（隐藏，不物理删除；被隔离技能的物化文件一并撤下，使其不再被加载）。记忆卡片显形巡检异常。插件诊断另有自己的 durable 家：宿主 logger 开箱没有 exporter，因此诊断只落 `plugin_log`，不再镜像宿主 logger；四张账本共用一个 30 天窗口裁剪，触发点是 store 就绪、写日志与提取后的巡检，按 UTC 日节流。
6. **卡片：记忆 + 评审设置** —— 挂在官方插件管理的本 bundle 页面（`plugins.bundle.config` slot，老宿主自动降级为无卡片）：形态对齐市场自家设置卡，内容对齐 ZCode 设置的记忆选项卡——上面的设置卡片改全局 `review.*`（两个开关 + 三个数字，显式保存；`enabled` 需重启，其余下一轮生效），不跟工作区下拉联动；下面的记忆卡片是只读投影——下拉作用域选择器列出库里的工作区分区（默认选中宿主当前工作区）、搜索框、每条记忆的相对更新时间、点击行内展开正文预览（5 MiB 上限）、巡检异常警告，以及技能区（本工作区技能 + 可见的全局技能，全局行打标记，同名时项目遮蔽全局），预览同记忆，每行显示查阅次数。显示名与描述走宿主 `locale/*.json` 通道双语；宿主主题 token、`Button` 原语、中英文案跟随 DSH 语言。记忆卡片没有编辑路径；设置卡片经宿主 config editor 写回，profile patch 仍是唯一真相源。

记忆类型沿 ZCode 分类法：`user`（画像与环境事实）、`feedback`（被纠正/确认的做法——正文必带 **Why:** 与 **How to apply:**）、`reference`（资源指针）。提取边界只收"跟人与环境走的知识"：决策与取舍天然属于仓库，走仓库的 ADR 路线，不进记忆库。

旧版 markdown 记忆库（`<workspace>/.evolve/memory/*.md`）在首次接触时无损导入，原目录改名为 `memory-imported-<date>/` 保留——不删不丢。

## 安装

```bash
# 从 npm（安装即激活——自带 bundle patch）
dsh plugin add dsh-continual-evolve

# 或从源码（首次 GitHub 安装需批准 allowBuilds 构建步骤）
dsh plugin add ZK-Andy/dsh-continual-evolve
```

安装或更新后，重启你实际使用的 DSH profile（`dsh web` 或桌面宿主）。

## 使用

无需命令。重启后第一场会话索引自动注入开场；对模型直接说记住/忘掉，经 `evolve_write` 过门禁落盘。想沉淀可复用的操作规程，直接让模型记为技能——经 `evolve_write` 落本项目并物化为 `SKILL.md`，重启后 `skill` 工具可发现；说到处都要用则由模型手动搬到全局（项目侧归档）。会话中途写入的记忆下个会话生效（会话内冻结守 prompt cache）。想看记忆库全貌，打开官方插件管理里本插件的页面：记忆卡片展示各工作区的记忆条目、搜索与巡检异常，上面的设置卡片改全局 `review.*` 取值。中央库需要 Node ≥ 22.5（`node:sqlite`，桌面宿主的 EnsureNode 运行时自带）；运行时过旧时插件整体降级为无操作并打控制台告警。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 是否注册记忆 section |
| `memoryIndex.guide` | `true` | 是否注入指南（关闭且索引为空时该 section 零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxChars` | `6000` | 注入索引的硬字符预算 |
| `memoryIndex.extraction` | `true` | 提案制提取运行（轮级、按会话分槽、无空闲计时器） |
| `review.enabled` | `true` | 内容质量自进化环（自有提示词/预算/账本，默认试运行） |
| `review.dryRun` | `true` | 只记 verdict 不落盘（试运行分布看顺后再关） |
| `review.dailyBudget` | `100` | 每天评审上限（新写 > 被纠正牵连 > 陈旧 > 抽查，尾部丢弃） |
| `review.batchSize` | `10` | 每次 drain 最多审几条 |
| `review.staleDays` | `30` | 已评审条目重回队列前要等几天（没产出 verdict 的评审从不算数） |
| `memoryCard.enabled` | `true` | 官方插件管理内的记忆 + 评审设置卡片（宿主缺 `webServer`/`plugins.bundle.config` 时自动降级为无卡片） |

`review.*` 全部是 volatile 字段：设置卡片可在不重挂载的情况下修改，调度器每次 drain 重新读取取值。

profile patch 示例：

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
      extraction: true
    review:
      dryRun: false
```

## 开发

```bash
pnpm install && pnpm build   # 依赖 + 干净构建 -> lib/
pnpm test                    # vitest（512 例）
pnpm test:coverage           # v8 覆盖率，CI 强制阈值
pnpm lint                    # oxlint src test client
pnpm check:pack              # 发布产物一致性（prepack 也会跑）
```

目录结构：

```
├── src/
│   ├── index.ts            # 注册：配置 + 宿主形状 + apply 编排
│   ├── assemble.ts         # 通用挂载：工具 + 提取 + 评审 + 自带技能
│   ├── store.ts            # 存储装配：打开/迁移、按类方法组装、对外重导出
│   ├── store-types.ts      # 存储表面（单 MemoryStore）+ 账本/账户形状
│   ├── data/               # 存储后端：连接、通用仓储 + 描述符、行/记录形状（单一家）、
│   │                       # 密钥筛查、迁移、账本、评审账目、巡检
│   ├── services/           # 应用服务：写门禁（规则 + 批量应用）、提取/评审环
│   │                       # （调度、链、提示词、子代理）、传输、记账、保留、md 导入、
│   │                       # 技能文件、插件日志
│   ├── pages/
│   │   └── memory-card/    # 插件管理页：路由 + 设置 + 挂载 + 工作区提示
│   └── surfaces/           # 表现层：统一 evolve_* 工具、注入、快照、section 文案 +
│                           # 指南、自带技能 provider（只读，巡检对账）
├── client/
│   └── client.js          # 手写 client bundle：记忆 + 评审设置双卡片
├── locale/                # 宿主包元数据：显示名 + 描述双语（zh/en）
├── test/                  # vitest 测试（40 个文件）
├── lib/                   # 构建产物（tsc）
├── docs/                  # design.md（设计）· FAQ.md（踩坑）
└── .agents/               # AI 协作层（AGENTS.md、技能、ADR 笔记）
```

## 文档

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md) · 存储决策：[`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)

## License

MIT。独立项目——与 DeepSeek 无关联。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
