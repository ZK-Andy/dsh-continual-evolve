# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-27%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-98%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-98%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的工作区记忆插件：每个工作区一个纯 markdown 记忆库（`<workspace>/.evolve/memory/`），会话开局注入索引，模型用**原生文件读写工具**直接使用——仅此而已。

## 为什么

Agent 每个会话积累的可复用经验（用户偏好、踩坑教训、项目背景）下个会话就忘。ZCode 用一个文件夹解决了这件事：一事一文的 md 记忆 + `MEMORY.md` 索引、开局注入、模型原生读写、没有任何专用机器。本插件把同一形态带给 DSH。

## 工作原理

1. **开局注入** —— 插件只注册一个 system-prompt section：注入 `MEMORY.md` 索引正文（超预算按整行截断并提示读目录）、记忆目录绝对路径、when_to_save 指南。该 section 每会话只算一次并逐字节复用，system prompt 稳定、prompt cache 持续命中；空 store 零 token。
2. **原生读写** —— DSH 对工作区内文件读写全放行（读路径从不设防，写围栏只围工作区外，见 [`docs/FAQ.md`](docs/FAQ.md) #6）。模型直接 Read/Write/Edit 记忆文件并维护索引；store 不存在时自动 bootstrap。
3. **治理即文件** —— 无版本、无快照、无审批、无后台提取：一条坏记忆就是工作区里一个可见的文件，删掉它就是退役。记忆是个人上下文，`.evolve/` 默认不进 git。

记忆文件格式（与 ZCode 一致）：frontmatter 带 `name` / `description`（决定未来会话会不会想起它）/ `metadata.type`（`user | feedback | project | reference`）；`feedback` 正文必带 **Why:** 与 **How to apply:**。

## 安装

```bash
# 从 npm（安装即激活——自带 bundle patch）
dsh plugin add dsh-continual-evolve

# 或从源码（首次 GitHub 安装需批准 allowBuilds 构建步骤）
dsh plugin add ZK-Andy/dsh-continual-evolve
```

安装或更新后，重启你实际使用的 DSH profile（`dsh web` 或桌面宿主）。

## 使用

无需命令、无需工具。重启后第一场会话，`.evolve/memory/` 会自动生成，索引自动注入开场；对模型直接说"记住……"/"忘掉……"即可，写入的记忆文件 + 索引行就是全部持久状态。会话中途写入的记忆下个会话生效（会话内冻结守 prompt cache）；需要立即查看时，模型直接读目录。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 是否注册记忆 section |
| `memoryIndex.guide` | `true` | 是否注入 when_to_save 指南（关闭且索引为空时该 section 零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxChars` | `6000` | 注入索引的硬字符预算 |

profile patch 示例：

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
```

## 开发

```bash
pnpm install && pnpm build   # 依赖 + tsc -> lib/
pnpm test                    # vitest（27 例）
pnpm test:coverage           # v8 覆盖率，CI 强制阈值
pnpm lint                    # oxlint src test
```

目录结构：

```
├── src/
│   ├── index.ts           # 注册：唯一 section + 配置
│   ├── memory-section.ts  # 注入：读索引 / bootstrap / 截断 / 会话冻结
│   └── memory-guide.ts    # 指南：when_to_save 与维护纪律（改编自 ZCode）
├── test/                  # vitest 测试（3 个文件）
├── lib/                   # 构建产物（tsc）
├── docs/                  # design.md（设计）· FAQ.md（踩坑）
└── .agents/               # AI 协作层（AGENTS.md、技能、ADR 笔记）
```

## 文档

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md) · 拆解决策：[`.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md`](.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md)

## License

MIT。独立项目——与 DeepSeek 无关联。
