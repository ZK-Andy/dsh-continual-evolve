# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-190%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-97%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-91%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的工作区记忆插件：全部记忆住在一个中央 SQLite 库里（`~/.dsh/evolve/memory.db`，按工作区路径行分区），会话开局注入索引，插件的代码是字面意义的**唯一写者**——模型提议，代码门禁后落盘。

## 为什么

Agent 每个会话积累的可复用经验（用户偏好、踩坑教训、项目背景）下个会话就忘。文件夹式的 md 记忆让记忆可见，但每一条写入都不设防：索引漂移、frontmatter 腐坏、超尺寸膨胀、密钥泄漏——坏写入落地之后才可见。本插件保留 ZCode 记忆形态（按工作区分区、开局注入索引、类型化记忆），把存储搬进一个所有变更都过机械门禁的数据库。

## 工作原理

1. **开局注入** —— 插件只注册一个 system-prompt section：注入本工作区的记忆索引（查库结果，只含钩子，超预算按整行截断，feedback > user > reference 排序）、中央库路径、三行指南。该 section 每会话只算一次并逐字节复用，system prompt 稳定、prompt cache 持续命中；空 store 零 token。
2. **两个工具，一个写者** —— `memory_write`（create/update/delete）承接显式的"记住……"/"忘掉……"：每条提案过代码门禁（id 规范、type 枚举、feedback 的 Why/How 契约、v1 移植的 secret 筛查、64KB 正文上限）后在一个事务内落盘。`memory_read` 按 id 取正文、按关键词检索——空格分隔的关键词取 AND，短词与 trigram 未命中时回退字面子串匹配；注入索引只有钩子。宿主没有工具服务时降级为"告诉用户"措辞，注入不受影响。
3. **提案制提取** —— 插件唯一的后台自动化，全程 `extraction_log` 可对账：每个 `agent/turn-stopping` 调度**该会话自己**的边界，状态按会话隔离（运行中只保留最新边界——合并而非排队；`compaction/start` 与会话收尾触发 drain），**没有空闲计时器**。一次运行读取该会话游标之后的轨迹增量，用 FTS 取相似既有记忆喂给一次 LLM 调用，模型的结构化提案过同一套门禁落盘；失败与被拒不推游标，下次触发重试。内部 agent、空增量、无真实用户文本的轮次、当轮已有显式 `memory_write` 的轮次机械跳过——每次跳过都记账。
4. **回滚靠账本，不靠机制** —— 每次变更落一条带 before/after 全文快照的 `extraction_log` 行；undo 就是取 before 重写。每次应用后随跑一次巡检：孤儿 FTS 行清除、含密钥条目隔离（隐藏，不物理删除）。只读卡片显形巡检异常。
5. **只读卡片** —— 挂在官方插件管理的本 bundle 页面（`plugins.bundle.config` slot，老宿主自动降级为无卡片）：形态对齐市场自家设置卡，内容对齐 ZCode 设置的记忆选项卡——下拉作用域选择器列出库里的工作区分区（默认选中宿主当前工作区）、搜索框、每条记忆的相对更新时间、点击行内展开正文预览（5 MiB 上限）、巡检异常警告。显示名与描述走宿主 `locale/*.json` 通道双语；宿主主题 token、`Button` 原语、中英文案跟随 DSH 语言。卡片是数据库的请求时投影，没有编辑路径。

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

无需命令。重启后第一场会话索引自动注入开场；对模型直接说"记住……"/"忘掉……"，经 `memory_write` 过门禁落盘。会话中途写入的记忆下个会话生效（会话内冻结守 prompt cache）。想看记忆库全貌，打开官方插件管理里本插件的页面：只读卡片展示各工作区的记忆条目、搜索与巡检异常。中央库需要 Node ≥ 22.5（`node:sqlite`，桌面宿主的 EnsureNode 运行时自带）；运行时过旧时插件整体降级为无操作并打控制台告警。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 是否注册记忆 section |
| `memoryIndex.guide` | `true` | 是否注入指南（关闭且索引为空时该 section 零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxChars` | `6000` | 注入索引的硬字符预算 |
| `memoryIndex.extraction` | `true` | 提案制提取运行（轮级、按会话分槽、无空闲计时器） |
| `memoryCard.enabled` | `true` | 官方插件管理内的只读记忆卡片（宿主缺 `webServer`/`plugins.bundle.config` 时自动降级为无卡片） |

profile patch 示例：

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
      extraction: true
```

## 开发

```bash
pnpm install && pnpm build   # 依赖 + 干净构建 -> lib/
pnpm test                    # vitest（190 例）
pnpm test:coverage           # v8 覆盖率，CI 强制阈值
pnpm lint                    # oxlint src test client
pnpm check:pack              # 发布产物一致性（prepack 也会跑）
```

目录结构：

```
├── src/
│   ├── index.ts            # 注册：section + 工具 + 提取 + 卡片接线
│   ├── store.ts            # 中央 SQLite 库：DDL/WAL/FTS、读面、账本、巡检、游标
│   ├── store-apply.ts      # 唯一写门：全量校验、事务原子应用、账本
│   ├── memory-rules.ts     # 机械门禁：枚举、尺寸、id 规范、secret 筛查
│   ├── memory-section.ts   # 注入：查库 / 截断 / 会话冻结
│   ├── memory-guide.ts     # 主会话指南（三行）
│   ├── memory-tools.ts     # memory_write + memory_read（宿主形状定义）
│   ├── extraction.ts       # 运行器 + 按会话分槽的调度器（轮级、无空闲计时器）
│   ├── extraction-surface.ts # 轨迹切片：游标、资格判定、序列化
│   ├── extraction-prompt.ts  # 提取 prompt + 应答解析
│   ├── import-md.ts        # 旧版 markdown 无损迁移
│   ├── memory-snapshot.ts  # 卡片：记忆库只读投影（条目 / 巡检 / 错误降级）
│   ├── card-routes.ts      # 卡片：webServer 上的 GET-only 只读 API
│   └── workspace-hint.ts   # 卡片：宿主当前工作区作为打开时的默认选中
├── client/
│   └── client.js          # 手写 client bundle：官方插件管理内只读卡片
├── locale/                # 宿主包元数据：显示名 + 描述双语（zh/en）
├── test/                  # vitest 测试（16 个文件）
├── lib/                   # 构建产物（tsc）
├── docs/                  # design.md（设计）· FAQ.md（踩坑）
└── .agents/               # AI 协作层（AGENTS.md、技能、ADR 笔记）
```

## 文档

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md) · 存储决策：[`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)

## License

MIT。独立项目——与 DeepSeek 无关联。
