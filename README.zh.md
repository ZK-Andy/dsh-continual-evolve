# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-538%20passing-brightgreen)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的持续自进化插件：一套**版本化、可审计、可回滚**的 harness 状态层——提示词补充、记忆、技能、子代理规格——从会话轨迹中沉淀而来。

**模型提议，代码保证。** 每一项机械化安全属性——schema 校验、原子写入、快照、版本、审计、接受决策——都由代码强制，从不依赖提示词自觉。

## 为什么

Agent 在每个会话里积累可复用经验（重复失败、持久事实、可复用流程），下个会话就忘掉。本插件把这些经验变成一等公民的持久状态：

- **local 会话级 / global 跨会话** 双作用域与合并语义——配合机械化晋升守卫，只有可携带、有分量、非重复的知识才能进全局
- **确定性回滚**：逆操作编辑由已应用结果生成——不靠 LLM 重新猜测
- **benchmark 闭环**：候选沉淀先经冻结用例 + 独立评分者评估再接受（rubric 加密落盘）

## 工作原理

1. **沉淀**——模型经 `evolve_add` 创建条目，或自动 review 门禁从会话轨迹提议（回合间隔 + 压缩检查点）。
2. **守卫**——代码强制校验：编辑 schema、blast-radius 与作用域一致性、晋升政策（项目专属标记 / 过薄内容 / 近似重复检测保持全局库干净）。全局 create 与既有条目高度相似（≥0.8）时写入即拒；中等重叠带 `conflictHint` 供后续合并。
3. **审批**——全局写入需明确人工批准；local 归宿提议先征询后落地。
4. **应用与注入**——原子应用带快照与审计事件。prompt 补充与委派规格注入系统提示词（封顶、按相关性排序、空 store 零 token）；memory/skill 以目录索引出现。
5. **验证与回滚**——benchmark 用冻结用例为候选打分；被拒候选确定性回滚。

## 安装

```bash
# 从 npm（安装即激活——自带 bundle patch）
dsh plugin add dsh-continual-evolve

# 或从源码（首次 GitHub 安装需批准 allowBuilds 构建步骤）
dsh plugin add ZK-Andy/dsh-continual-evolve
```

安装或更新后重启 `dsh web`。

## 使用

会话内命令：

| 命令 | 效果 |
|---|---|
| `/evolve` | 帮助 + 当前 local store |
| `/evolve list · history · rollback <id>` | 查看与回滚（加 `global` 操作跨会话库） |
| `/evolve plan [msg]` | 对 store 运行 LLM 规划器 |
| `/evolve wrapup` | 收尾本会话 local 条目：晋升 / 归档 / 保留 |
| `/evolve archive · unarchive · demote <id>` | 从注入中隐藏（数据保留可恢复）——`demote` 针对全局噪声 |
| `/evolve failures` | 失败类聚合（门禁 + benchmark） |
| `/evolve log [tail N] [session <id>]` | 插件日志 |
| `/evolve export · import <path>` | 备份 / 恢复 store |
| `/evolve mount · unmount <skillId>` | 把可执行技能热挂载为 live 插件 |
| `/evolve goal [objective · done · block]` | 回合驱动的自进化目标 |
| `/evolve benchmark …` | 用例生命周期、运行、接受决策 |

模型工具：`evolve_list / add / update / delete / rollback`。

注入形态：prompt 补充与委派规格带内容注入（每 kind ≤6 条 × 180 字符，按相关性排序）。memory/skill 以目录索引出现（`[kind:id] 标题`，15 行封顶 + 折叠计数行）——全文经 `evolve_list` 获取。空 store = 零注入 token。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `baseDir` | 解析后的 DSH home | `evolve/` 存储根目录 |
| `autoReview` | `false` | 启用自动 review 门禁 |
| `reviewIntervalTurns` | `6` | 回合间隔路径的门禁节奏 |
| `maxReviewInputChars` | `40000` | 交给门禁的轨迹切片 |
| `reviewBudgetTokens` | `4096` | 门禁调用输出预算 |
| `notifyOnAutoReview` | `true` | 门禁应用后发可见跟进通知 |
| `requireGlobalApproval` | `true` | 全局写入需明确批准 |
| `localFate` | `true` | 门禁审计本地条目并提议晋升/归档（先征询，绝不静默） |
| `fateIntervalTurns` | 跟随 `reviewIntervalTurns` | 归宿评估的最小回合间隔 |
| `goalBlockedWrapupTurns` | `3` | 连续阻塞目标的门禁轮数触发一次归宿评估（`0` 关闭） |
| `promotionBlockPatterns` | POSIX 路径、session id、`~/.dsh` | 内容命中即判定项目专属，永不晋升全局 |
| `promotionMinChars` | `100` | 低于此长度的整体晋升留在本地 |
| `injectionDirectoryLines` | `15` | 每次构建的目录行数上限，超出折叠为计数行 |
| `sectionOrder` | `118` | 系统提示词 section 顺序 |
| `skillsDir` | `<dshHome>/skills` | 技能条目物化为 SKILL.md 的根目录 |
| `rubricKey` | 自动生成本地密钥文件 | benchmark rubric 的 AES-256-GCM 口令（`DSH_EVOLVE_RUBRIC_KEY` 可覆盖） |
| `logToFile` / `logLevel` / `logMaxBytes` | `true` / `1` / 5 MiB | 插件自带 JSONL 文件日志带轮转 |
| `autoRollbackOnReject` | `true` | benchmark 拒绝后自动确定性回滚 |
| `reviewModel` | agent 自身 | 门禁可选更便宜的模型（`"provider/model"`） |

profile patch 示例：

```yaml
- id: continual-evolve
  config:
    autoReview: true
    reviewIntervalTurns: 6
```

## 开发

```bash
pnpm install && pnpm build   # 依赖 + tsc -> lib/
pnpm test                    # vitest（538 例）
pnpm test:coverage           # v8 覆盖率，CI 强制阈值
pnpm lint                    # oxlint src test
```

目录结构：

```
├── src/                   # 引擎、工具、命令、门禁、fate、benchmark、usage…
├── test/                  # vitest 测试套件（33 个文件）
├── lib/                   # 构建产物（tsc）
├── docs/
│   ├── design.md          # 完整设计文档（硬化矩阵）
│   ├── FAQ.md             # 真实踩坑记录
│   ├── gap-analysis.md    # 对照 prime-agent /refine + penguin-harness
│   ├── experiment-bootstrap.md
│   ├── archive/           # 已完结的一次性报告
│   └── research/          # penguin 报告 + prime-agent 注释源码
├── examples/README.md     # 种子 benchmark 用例
└── .agents/               # AI 协作层（AGENTS.md、技能、ADR 笔记）
```

## 文档与出处

- 设计：[`docs/design.md`](docs/design.md) · 踩坑：[`docs/FAQ.md`](docs/FAQ.md) · 差距分析：[`docs/gap-analysis.md`](docs/gap-analysis.md) · D2 实验:[`docs/experiment-bootstrap.md`](docs/experiment-bootstrap.md)
- 血统：**penguin-harness**（概念；Apache-2.0）——报告见 [`docs/research/penguin-harness-self-evolution.md`](docs/research/penguin-harness-self-evolution.md)；**prime-agent `/refine`**（工程形态；MIT）——注释参考源码见 [`docs/research/prime-agent-refinement.ts`](docs/research/prime-agent-refinement.ts)。本包是面向 DSH 插件表面的原创实现。

## License

MIT。独立项目——与 DeepSeek 无关联。
