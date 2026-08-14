# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-86%20passing-brightgreen)]()
[![Status](https://img.shields.io/badge/status-all%20phases%20complete-ff69b4)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的持续自进化插件：一套**版本化、可审计、可回滚**的 harness 状态层——提示词补充、记忆、技能、子代理规格——从会话轨迹中沉淀而来。

> **状态：全部阶段完成。** Phase 2 补齐了真实系统提示词段：`prompt` 条目注入为 additive 提示词补充、`subagent` 条目注入为可复用委派规格——均封顶（每类 6 条、180 字符）、沿父会话链被子代理继承、store 为空时整段丢弃（零 token 成本）。之上，Phase 3 的评估矩阵执行器（host 平面 `subagents`、冻结运行时、结构化输出单元）驱动代码所有的计分板；非退化接受规则决定接受/拒绝，模型从不直接写聚合值。

## 背景

这个项目始于一个研究问题：*harness 能自我改进吗？生产级版本长什么样？* 三条证据线塑造了答案：

- **penguin-harness** 证明了概念（benchmark → 评估 → 优化 → 接受/回滚），但**代码层零强制**——所有保证都是提示词契约。它的研究报告（`docs/research/`）成了本项目的硬化清单。
- **prime-agent `/refine`** 证明了工程形态：版本化 harness 条目、原子持久化、乐观并发、逆操作回滚。本包是在 DSH 插件表面上对该形态的原创实现。
- 学术工作（Self-Harness、AHE、HarnessOpt-Bench）提供了纪律：冻结评估运行时、代码所有聚合、非退化接受。

结果：**模型提议，代码保证。** 每一项机械化安全属性（schema 校验、快照、版本、审计、接受决策）都由代码强制——从不要求模型自觉守规矩。

## 为什么

Agent 在每个会话里积累可复用经验——重复失败、持久事实、可复用流程——然后在下个回合或下个会话忘掉。本插件把这些经验变成一等公民的持久状态：

- **版本化条目**：按 `prompt` / `memory` / `skill` / `subagent` 分键，每条带来源与版本
- **证据链**：每次进化追加一条携带 `trigger / changes / evidence / outcome` 的事件
- **确定性回滚**：逆操作由已应用的结果生成——不需要 LLM 再猜
- **代码强制安全**，而非提示词纪律：schema 校验、原子写、损坏降级、乐观并发、基础系统提示词不可变
- **局部（会话内）与全局（跨会话）双作用域**，带合并语义

## 设计来源

受三方面工作启发（见 [`docs/design.md`](docs/design.md)）：

- **prime-agent `/refine`**（MIT）：本包实现的状态模型、原子持久化、乐观并发、逐条校验与逆操作回滚——参考源码在 [`docs/research/prime-agent-refinement.ts`](docs/research/prime-agent-refinement.ts)。代码为原创实现，面向 DSH 插件表面编写。
- **penguin-harness**（Apache-2.0）：benchmark 驱动的进化循环——研究报告在 [`docs/research/penguin-harness-self-evolution.md`](docs/research/penguin-harness-self-evolution.md)；其"纯提示词契约"正是本包要硬化的反面教材。
- 学术：Self-Harness（arXiv 2606.09498）、AHE（arXiv 2604.25850）、HarnessOpt-Bench（arXiv 2608.06301）。

## 技术栈

| 层 | 选择 |
|---|---|
| 语言 | TypeScript（strict、ES2024、ESM） |
| 运行时 | Node `^22.19.0 \|\| >=24.0.0`（与 DSH 一致） |
| 插件接缝 | `@deepseek-ai/cordis`（`name` / `apply` / `inject` 入口） |
| 包管理 | pnpm（DSH 生态标准） |
| 构建 | `tsc` → `lib/`（main `lib/index.js`，types `lib/index.d.ts`） |
| 测试 | Vitest |
| Lint | oxlint（DSH 官方仓库惯例） |
| License | MIT |

## 项目结构

```
dsh-continual-evolve/
├── package.json          # exports / files / engines / scripts + dsh.bundle manifest
├── cordis.patch.yml      # bundle patch（dsh plugin add 安装即激活）
├── tsconfig.json / .oxlintrc.json / .editorconfig / .gitignore
├── LICENSE / README.md / README.zh.md
├── docs/
│   ├── design.md               # 完整设计文档（含硬化对照表）
│   └── research/               # penguin 研究报告 + prime-agent 参考源码
├── src/
│   ├── index.ts          # cordis 插件入口（服务挂载 + 接线）
│   ├── types.ts          # HarnessState / 条目 / 编辑 / 结果类型
│   ├── state.ts          # 原子持久化、损坏降级、合并、乐观并发
│   ├── validate.ts       # 代码强制编辑校验（基础提示词不可改、skill 契约）
│   ├── apply.ts          # 逐条应用 + 乐观锁
│   ├── rollback.ts       # 确定性逆操作回滚
│   ├── plan.ts           # 提案 JSON 解析（截断诊断）
│   ├── tool.ts           # evolve_* 模型工具（5 个）
│   ├── command.ts        # /evolve 命令（含 benchmark 子命令）
│   ├── planner.ts        # ctx.llm 规划器
│   ├── render.ts         # 有界提示词渲染
│   ├── inject.ts         # 动态系统提示词段（prompt 补充 + 委派规格）
│   ├── auto.ts           # 自动 review 门禁（回合/压缩触发 + 审计）
│   ├── review.ts         # 门禁 LLM 判断
│   ├── approval.ts       # 全局写入人工审批
│   ├── skill.ts          # 技能物化（$DSH_HOME/skills/）
│   ├── benchmark.ts      # benchmark 存储
│   ├── score.ts          # 代码所有聚合 + 接受规则
│   ├── evaluate.ts       # 评估矩阵执行器（结构化输出子代理）
│   ├── store.ts          # store 布局 + 快照 + 结果历史
│   └── service.ts        # 进化引擎（onApplied 钩子）
└── test/                 # 13 个文件，86 个测试
```

## 会话内用法（安装后）

```
/evolve                       帮助 + 当前局部 store
/evolve list [global]         列出条目
/evolve history               已应用的 refinement（回滚用 id）
/evolve rollback <id>         确定性回滚某个 refinement
/evolve export <path>         备份局部 store 为 JSON
/evolve import <path>         从导出文件恢复 store
/evolve plan [msg]            LLM 规划器
```

模型工具：`evolve_list`、`evolve_add`、`evolve_update`、`evolve_delete`、`evolve_rollback`。

## benchmark 驱动验证（Phase 3）

```
/evolve benchmark new <title>                         创建 benchmark
/evolve benchmark add-case <bid> <title> <statement> <rubric>
/evolve benchmark list                                列出 benchmark
/evolve benchmark status <bid>                        查看计分板 + 决策
/evolve benchmark reset <bid>                         清空计分板（重跑参考线）
/evolve benchmark run <bid>                           评估当前状态 → 参考线
/evolve benchmark run <bid> candidate <refinementId>  评估进化后状态 → 决策
```

闭环：冻结参考分 → 进化候选（`/evolve plan`）→ 用同一 case × run 矩阵复测进化后状态 → **代码所有**的接受规则只在总体均值严格提高且无 case 退化时保留候选（Self-Harness 风格）。模型只产出原始细胞级分数；聚合与决策都在 `src/score.ts`。rubric 隔离靠构造（规划器的提示词永远不含 rubric 文件）；拒绝会记录并提示回滚（人工在环，不自动回滚）。

### 真实运行记录（ACCEPT）

一次真实的 `dsh web` 会话，一个 case、一个候选——第一次真正的接受：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 参考线 | `/evolve benchmark run lint_convention` | **90**——评估子代理真的 grep 了 harness store，报告"lint/ruff/eslint/mypy 在所有条目中零出现" |
| 进化候选 | `/evolve plan 记住：写代码前必须先运行适用的 lint 检查` | 创建 `memory:convention_lint_before_code` |
| 复测 | `/evolve benchmark run lint_convention candidate <id>` | **100**——评估器跑 `evolve_list` 命中记忆并逐字引用 |
| 决策 | — | `overall: 90 → 100` · `lint_knowledge: 90 → 100` · **DECISION: ACCEPTED** |

评估器评的不是模型常识，而是**被测 harness 状态本身**（grep、`evolve_list` 检查）——所以 harness 的改动会真实地反映在分数上。同一会话早些时候还产生过诚实的 `REJECTED` 决策（0→0 占位符 case、100→100 满分基线无法超越）。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseDir` | 解析后的 DSH home | `evolve/` store 的根 |
| `sectionOrder` | 118 | 系统提示词段落顺序 |
| `autoReview` | `false` | 启用自动 review 门禁（每间隔一次廉价模型调用） |
| `reviewIntervalTurns` | 6 | 距上次 review 满这么多回合时触发门禁 |
| `maxReviewInputChars` | 40000 | 交给门禁的轨迹切片 |
| `reviewBudgetTokens` | 4096 | 门禁调用的输出预算 |
| `requireGlobalApproval` | `true` | 跨会话（全局）编辑需用户批准"批准"后才应用 |
| `skillsDir` | `<dshHome>/skills` | 技能条目物化为 SKILL.md 包的根目录 |
| `rubricKey` | `DSH_EVOLVE_RUBRIC_KEY` → dev 键 | rubric 加密（AES-256-GCM）口令：benchmark rubric 明文永不着盘 |

示例（profile `cordis.patch.yml`）：

```yaml
- insert:
    - id: continual-evolve
      name: 'dsh-continual-evolve'
      config:
        autoReview: true
        reviewIntervalTurns: 6
```

## 安装

```bash
# 从 npm 安装（安装即激活，自带 bundle patch）
dsh plugin --profile web add dsh-continual-evolve

# 或从源码安装
dsh plugin --profile web add /path/to/dsh-continual-evolve
```

## 开发

```bash
pnpm install        # 安装开发依赖
pnpm dev            # tsc --watch
pnpm build          # tsc -> lib/
pnpm test           # vitest run
pnpm lint           # oxlint src test
```

遇到问题先看 [`docs/FAQ.md`](docs/FAQ.md)（真实踩坑记录：服务平面、schema DSL、结构化输出、门禁计数、注入验证等）。

## 路线图

- **Phase 1（完成）**：纯核心引擎——状态模型、校验、应用、回滚、提案解析；已测试。
- **Phase 1b（完成）**：`evolve_*` 工具、`/evolve` 命令、`ctx.llm` 规划器；已装入 web profile。
- **Phase 2（完成）**：✅ 自动 review 门禁（回合间隔）；✅ 压缩检查点（`compaction/start`）；✅ 全局人工审批门禁（userQuestions）；✅ 可执行技能（物化到 `$DSH_HOME/skills/`）；✅ prompt 条目注入为真实系统提示词段（additive、每类封顶 6 条、沿父链被子代理继承）；✅ subagent 条目渲染为委派接缝上的可复用委派规格。
- **Phase 3（完成）**：✅ benchmark 驱动验证闭环——评估矩阵、代码所有计分板聚合、非退化接受规则、rubric 构造性隔离；✅ rubric ACL（明文永不着盘——AES-256-GCM 信封，仅评估执行器解密）；✅ 技能热挂载插件（`/evolve mount <skillId>`，实时 loader 条目，重启自动恢复）；✅ goal 驱动的进化轮次（`/evolve goal`——active goal 让 review 门禁每轮触发）。（未来：拒绝自动回滚。）

## License

MIT。独立项目——与 DeepSeek 无关联。
