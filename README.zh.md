# dsh-continual-evolve

[English](README.md) | 中文

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-290%20passing-brightgreen)]()
[![Status](https://img.shields.io/badge/status-all%20phases%20complete%20%C2%B7%20maintenance-ff69b4)]()

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的持续自进化插件：一套**版本化、可审计、可回滚**的 harness 状态层——提示词补充、记忆、技能、子代理规格——从会话轨迹中沉淀而来。

> **状态：全部阶段完成，进入长期维护。** Phase 1–3 交付了完整进化闭环：纯核心引擎、模型工具与 `/evolve` 命令、自动 review 门禁（回合间隔 + 压缩检查点、全局写入人工审批）、真实系统提示词注入（prompt 补充 + 委派规格，空 store 零 token 成本）、benchmark 驱动验证闭环（代码所有计分、非退化接受、rubric ACL）。此后插件随真实使用持续增强——记忆层（排序注入、轨迹引用、归档）、每安装实例独立的 rubric 密钥、插件自带文件日志、会话收尾（`/evolve wrapup`）、以及门禁的自动 local 归宿维度（local 条目在门禁自有节奏下获得提升或归档的归宿——先征询、绝不静默写入）。已交付与候选清单见"路线图"。

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
│   ├── inject.ts         # 动态系统提示词段（prompt 补充 + 委派规格，打分排序注入）
│   ├── source.ts         # 轨迹引用（沉淀条目的 sessionId + 事件 seq）
│   ├── auto.ts           # 自动 review 门禁（回合/压缩触发 + 审计，global 感知视图，local 归宿阶段）
│   ├── fate.ts           # 门禁 local 归宿维度——自动提议 local 条目提升/归档（先征询、带冷却）
│   ├── notify.ts         # 门禁可见性——approved 自动沉淀后发送可见通知
│   ├── goal.ts           # goal 驱动的进化轮次（/evolve goal）
│   ├── review.ts         # 门禁 LLM 判断（拒绝 global 已覆盖主题的 local 重复沉淀）
│   ├── approval.ts       # 全局写入人工审批
│   ├── skill.ts          # 技能物化（$DSH_HOME/skills/）
│   ├── skillquality.ts   # 自进化环中的技能标准（skill-creator 模板读取 + frontmatter 代码校验）
│   ├── mount.ts          # 技能热挂载插件（loader.create + 启动恢复）
│   ├── benchmark.ts      # benchmark 存储
│   ├── rubric.ts         # rubric ACL（AES-256-GCM 密文信封，自动生成本地密钥）
│   ├── logfile.ts        # 插件自带文件日志（JSONL exporter + 轮转）
│   ├── score.ts          # 代码所有聚合 + 接受规则
│   ├── evaluate.ts       # 评估矩阵执行器（结构化输出子代理）
│   ├── pool.ts           # 评估运行的有界并发工作池
│   ├── store.ts          # store 布局 + 快照 + 结果历史
│   ├── service.ts        # 进化引擎（onApplied 钩子）
│   └── wrapup.ts         # 会话收尾生命周期（提升/拆解提升到 global、带守卫的归档；共享 proposal 构造器）
└── test/                 # 23 个文件，290 个测试
```

## 安装

```bash
# 从 npm 安装（安装即激活，自带 bundle patch）
dsh plugin --profile web add dsh-continual-evolve

# 或从源码安装（首次 GitHub 安装需按提示授权 allowBuilds 构建步骤）
dsh plugin --profile web add github:ZK-Andy/dsh-continual-evolve
```

将 `web` 换成你的 profile 名（`headless`，或自定义 profile）。

## 会话内用法（安装后）

```
/evolve                       帮助 + 当前局部 store
/evolve list [global]         列出条目
/evolve history               已应用的 refinement（回滚用 id）
/evolve rollback <id>         确定性回滚某个 refinement
/evolve plan [msg]            LLM 规划器
/evolve wrapup                评估本会话 local 条目：可复用的提升到 global（需审批），
                              会话特有的一次性条目归档
/evolve archive <id>          归档条目——不再注入（数据保留，可恢复）
/evolve unarchive <id>        恢复已归档条目
/evolve log [tail N] [session <id>] 查看最近插件日志（默认 50 行；可加会话过滤）
/evolve export <path>         备份局部 store 为 JSON
/evolve import <path>         从导出文件恢复 store
/evolve mount <skillId>       热挂载 skill 条目为实时 cordis 插件（工具：skill_<name>）
/evolve mount list            列出热挂载插件（重启自动恢复）
/evolve unmount <id>          移除热挂载插件
/evolve goal                  查看进化 goal（轮次驱动自动 review）
/evolve goal <objective>      创建/更新进化 goal——active 时 review 门禁每轮触发
/evolve goal done             完成进化 goal
```

模型工具：`evolve_list`、`evolve_add`、`evolve_update`、`evolve_delete`、`evolve_rollback`。

## 记忆层

在持久 store 之外，四项增强让注入的记忆在条目增多时依然"懂你"（对照 Mem0 / Letta / Zep / LangMem 的差距分析；不引入外部服务——全部是纯函数）：

- **打分排序注入**——某类条目超过 6 条封顶时，注入块不再固定取前 6 条：先按与 agent 最近直接用户消息的相关度打分（关键词/BM25 级别，标题命中权重 2×），再按新鲜度排序（`updated_at`，30 天半衰期），让"最新 + 最相关"的条目填满封顶。空 store 零 token 行为不变。
- **轨迹引用**——每条新沉淀条目都会记录 `metadata.sourceSession` + `metadata.sourceSeqs`，指向它蒸馏自的直接用户消息（DSH 会话是事件溯源、seq 连续，引用可展开回持久会话日志）。列表显示 `src=<sessionId>:<seqs>`；旧条目不迁移也不报错。
- **归档**——`/evolve archive <id>` 让条目不再注入（`metadata.archivedAt`，数据保留、与快照/回滚兼容），`/evolve unarchive <id>` 恢复。归档条目在 `evolve_list` 中标记 `[archived]`，注入跳过，溢出计数不含它们。
- **会话收尾**——否则会话结束时的 local 条目会变成孤岛（后续会话永远看不到）。`/evolve wrapup` 给它们一个归宿：先机械审计——**全局覆盖只看标题相似**（裸同 id 但标题迥异**不算**覆盖；实际命中的全局标题会展示给分类器，让它对照真实内容判断）——再由模型逐条分类为 `promote` / `archive` / `keep`。提升把可复用条目写入 global store——**经人工审批门禁**，保留轨迹引用并追加 `sourcedFromLocal=<session>:<id>` 反向回引；本地副本随后盖 `promotedTo` 戳退出注入，永不再被提议。**拆解提升（A 形）**：混合条目（持久事实 + 会话快照）可整体归档、同时带一个清洗过的 `promote` 子对象——只有持久部分落进 global，快照留在归档里。**对称归档守卫**：未被全局覆盖、且源自真实用户消息的归档，先征求用户确认才隐藏内容（防过度归档与防过度写入获得同等保护）；操作性条目仍静默归档。一切仍走快照/版本/可回滚。
- **门禁 local 归宿（自动收尾）**——同一套 wrap-up 机制现在以内置节奏（`fateIntervalTurns`）跑在自动 review 门禁里：local 条目在会话进行中就能获得归宿，不必等手动 `/evolve wrapup`。每次到期的门禁运行都会审计候选条目、由分类器分类、再经同一套确定性守卫划分；任何治理动作落地前**先征询用户**（一个弹窗覆盖提升、拆解提升与需确认归档——consultSkillEdits 模式，带拒绝冷却）。被全局覆盖或操作性条目仍静默归档；压缩时刻门禁绝不弹窗：只做静默归档，治理动作以审计记录推迟并指向 `/evolve wrapup`。每次 fate 决策都落进 `reviews.jsonl`（`approved` / `declined` / `deferred` / `assessed` / `failed`），已执行动作通过后续通知可见。应用写入与 wrapup 命令逐字节一致（共享 proposal 构造器）。
- **global 感知门禁**——自动 review 门禁与规划器评审的是合并后的 global + local 状态，每条条目标注真实 scope；global 已覆盖的主题会被 declined，不再重复沉淀为 local 条目。

## 自进化环中的技能标准

规划器与自动门禁是裸 `ctx.llm` 调用——不在 agent 会话内，无法通过 `skill` 工具加载技能。为了让自进化长出的技能保持在质量线上，插件在运行时引用 **skill-creator** / **skill-audit** 技能（作者从官方 deepseek-harness 11 个技能蒸馏的自建技能，模板事实核验自官方源码 `47f9438`；留在磁盘上作为单一事实源，零复制）：

- **每次规划调用注入 `<skill_quality_standard>` 块**：`skill-creator/references/template.md` 事实（技能已安装时，位于 `<dshHome>/skills/`），否则用内置精华版兜底（约 1KB，低频调用）。规划器必须把技能提案锚定在轨迹中的**真实触发场景**、不得重复官方 11 技能或已有条目，并逐条自检 7 条结构特征。
- **门禁按 skill-audit 维度评审**技能相关轨迹（frontmatter 路由、结构特征、段落骨架、防重复），不达标的提案 declined 并说明改进方向。
- **机械 frontmatter 规则代码强制**（移植 `validate-frontmatter.mjs`）：技能正文不得以第二个 `---` 块开头（会遮蔽自动生成的 frontmatter）、资源引用不得越出技能目录；物化后对渲染产物复检，悬空 `references/`/`scripts/` 引用记 warn 日志。
- **两种技能形态**——`executable`（可执行，保留 python reference 契约，可热挂载为工具）与 `guidance`（指导型：SKILL.md 文档、无 reference，用于反复出现的多步流程，如会话开始/结束、交接流程）。代码强制区分：guidance 技能**不得**携带 reference 或 arguments 契约。
- **用户治理的技能创建**——门禁绝不静默写技能：规划器提议技能编辑时，先问用户（固化/不固化）再落地；被拒候选在冷却窗口内不再打扰。提案其余部分（记忆/提示词沉淀）不受影响照常进行——技能决策永不阻塞普通沉淀。

## 日志

插件自带文件日志：所有 cordis 日志消息（本插件或其他插件）追加写入 `<dshHome>/evolve/plugin.log`（JSONL、0600，超过 `logMaxBytes` 轮转到 `plugin.log.1`）。与 `dsh web` 的启动方式无关——无需安装额外组件、不依赖启动脚本。查看方式：

```bash
tail -f ~/.dsh/evolve/plugin.log          # 实时跟随
/evolve log 100                            # 在对话里看最近 100 行
```

前台终端想要实时输出时，可（可选）在 profile 加官方 `@deepseek-ai/cordis-plugin-logger-console` 插件；文件日志始终是默认存在的基础。

## benchmark 驱动验证（Phase 3）

```
/evolve benchmark new <title> [runs]                   创建 benchmark（runs = 每个 case 重复次数，默认 1）
/evolve benchmark add-case <bid> <title> <statement> <rubric>
/evolve benchmark list                                列出 benchmark
/evolve benchmark status <bid>                        查看计分板 + 决策
/evolve benchmark reset <bid>                         清空计分板（重跑参考线）
/evolve benchmark run <bid>                           评估当前状态 → 参考线
/evolve benchmark run <bid> candidate <refinementId>  评估进化后状态 → 决策
```

闭环：冻结参考分 → 进化候选（`/evolve plan`）→ 用同一 case × run 矩阵复测进化后状态 → **代码所有**的接受规则只在总体均值严格提高且无 case 退化时保留候选（Self-Harness 风格）。模型只产出原始细胞级分数；聚合与决策都在 `src/score.ts`。rubric 隔离靠构造（规划器的提示词永远不含 rubric 文件）；拒绝会记录进 scoreboard 并自动回滚该 refinement（`autoRollbackOnReject`，默认开）。

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
| `notifyOnAutoReview` | `true` | 门禁 approved 且实际应用了编辑后，在会话中排一条可见通知（沉淀条目 + 回滚命令） |
| `requireGlobalApproval` | `true` | 跨会话（全局）编辑需用户批准"批准"后才应用 |
| `skillsDir` | `<dshHome>/skills` | 技能条目物化为 SKILL.md 包的根目录 |
| `rubricKey` | 自动生成的本地密钥文件（`<dshHome>/evolve/rubric.key`，0600）→ dev 兜底 | rubric 加密（AES-256-GCM）口令：benchmark rubric 明文永不着盘。未配置时插件首次使用自动生成随机密钥文件——每台安装实例一把独立密钥，零配置；`DSH_EVOLVE_RUBRIC_KEY` 为环境变量覆盖项 |
| `logToFile` | `true` | 所有 cordis 日志消息写入 `<dshHome>/evolve/plugin.log`（JSONL、0600）——插件自带日志，与启动方式无关、无需安装额外组件 |
| `logLevel` | `1` | 文件日志级别：0=error、1=info、2=warn、3=debug |
| `logMaxBytes` | 5 MiB | 超过该大小轮转到 `plugin.log.1` |
| `autoRollbackOnReject` | `true` | benchmark 决策拒绝候选后自动回滚该 refinement（与 `/evolve rollback` 同一引擎路径——确定性、快照、审计） |
| `localFate` | `true` | 门禁 local 归宿维度：门禁按自有节奏审计本会话 local 条目并提议提升/归档——先征询、绝不静默写入（仅 `autoReview` 开启时有效） |
| `fateIntervalTurns` | 跟随 `reviewIntervalTurns` | 回合间隔路径上两次 local 归宿评估的最小间隔（压缩时刻无条件触发） |

示例（profile `cordis.patch.yml`）：

```yaml
- insert:
    - id: continual-evolve
      name: 'dsh-continual-evolve'
      config:
        autoReview: true
        reviewIntervalTurns: 6
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

对照 prime-agent `/refine` 与 penguin-harness 的差距与下一步实施项（P0：评估者/评分者分离、失败格协议）：[`docs/gap-analysis.md`](docs/gap-analysis.md)。

## 路线图

**已交付**

- **Phase 1–3（完成）**：纯核心引擎（状态模型、校验、应用、回滚、提案解析）→ `evolve_*` 工具 + `/evolve` 命令 + `ctx.llm` 规划器 → 自动 review 门禁（回合间隔 + 压缩检查点、approved 后可见通知）、全局人工审批、可执行技能、真实系统提示词注入（prompt 补充 + 委派规格，子代理沿父链继承）、benchmark 驱动验证闭环（代码所有计分板、非退化接受、rubric 构造性隔离）、技能热挂载插件、goal 驱动的进化轮次。
- **2026-08 维护期增强（完成）**：
  - **记忆层**——排序注入（相关度 + 新鲜度打分填满每类封顶）、轨迹引用（`metadata.sourceSession` + `sourceSeqs`，显示为 `src=session:seqs`）、归档/恢复（`/evolve archive <id>`，注入跳过归档条目）、global 感知门禁（拒绝 global 已覆盖主题的 local 重复沉淀）
  - **每安装独立 rubric 密钥**——自动生成本地密钥文件（`<dshHome>/evolve/rubric.key`，0600）；不再有全世界公开的 dev 键
  - **插件自带文件日志**——所有 cordis 日志消息写入 `<dshHome>/evolve/plugin.log`（JSONL、0600、自动轮转），`/evolve log` 查看；与启动方式无关、无需安装额外组件
  - **轨迹接地规划**——`/evolve plan`（及所有规划调用，含门禁 refine 步骤）现在读取会话轨迹：从调用方会话日志提取最近直接用户消息，作为 `<session_trajectory>` 块喂给规划器，提案以用户真实说过的话为依据（显式 `trajectory` 覆盖；空轨迹省略、零成本）
  - **门禁提议归档**——过时条目是一等 refine 目标：规划器可输出 `action: "archive"`（仅需 kind + id），代码经正常 apply 通道盖 `metadata.archivedAt` 戳——快照、版本 +1、审计事件、以及恢复归档前状态的确定性回滚逆编辑。归档隐藏于注入但绝不删除；重复归档被拒绝；基础系统提示词保持不可变
  - **benchmark 拒绝自动回滚**——接受闭环已闭合：代码所有决策拒绝候选时，refinement 经与 `/evolve rollback` 相同的引擎路径自动撤销（确定性逆编辑、快照 + 审计；`autoRollbackOnReject` 配置，默认开）。失败时给出手动回滚提示而不是抛错
  - **日志按会话过滤**——`/evolve log [tail N] [session <id>]` 只保留提及指定会话 id 的行（精确 token 匹配，取自渲染消息与原始 args）；门禁记录的行现在携带会话 id
  - **自进化环中的技能标准**——规划器与门禁现在按 skill-creator/skill-audit 标准（作者蒸馏自官方 deepseek-harness 11 技能）创作与评审技能条目：每次规划注入 `template.md` 事实（内置精华版兜底）为 `<skill_quality_standard>`；apply 代码强制 frontmatter 机械规则（禁止遮蔽 `---`、禁止越界资源引用）；物化后的 SKILL.md 复检，悬空资源引用记日志;
  - **guidance 技能形态 + 用户治理创建**——第二种技能形态（无 python reference 的 SKILL.md 文档技能）让反复出现的流程可以被提议为技能；门禁把每次自动创建的技能先交给用户决定（固化/不固化）再落地，带拒绝冷却——技能在治理下生长，绝不静默写入
- **2026-08-17 收尾 wave（完成）**：
  - **`/evolve wrapup`**——会话结束时 local 条目有了真正的归宿：先机械审计（local 候选 + 全局覆盖检测；**覆盖只看标题相似**——裸同 id 但标题迥异**不算**覆盖，真正命中的全局标题会展示给分类器）→ LLM 分类（`promote` / `archive` / `keep` + A 形拆解提升：混合条目整体归档、同时提升清洗出的持久子对象）→ 应用时刻确定性守卫复检（promote 永不写出全局重复；对称归档守卫要求用户确认后才隐藏未被覆盖、源自真实对话的条目；清洗标题撞全局主题的拆解降级为普通归档）→ 所有全局 create 走一个人工审批门
  - **门禁 local 归宿维度**——wrap-up 机制现在以内置节奏（`fateIntervalTurns`，压缩时刻无条件）跑在自动 review 门禁里：local 条目在会话进行中被审计、分类、划分；治理动作先征询（一个弹窗、拒绝冷却），被覆盖/操作性条目静默归档，压缩时刻只做静默归档并以审计记录推迟治理动作；每次决策落进 `reviews.jsonl`，已执行动作发后续通知。应用写入与 wrapup 命令共享构造器（逐字节一致）

候选/待办清单暂时为空——后续工作随真实使用驱动。

## License

MIT。独立项目——与 DeepSeek 无关联。
