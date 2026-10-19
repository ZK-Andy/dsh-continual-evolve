# Agent Note: P5b 评测跑批与 runner（四臂首跑机械 + 手动触发工具）

Status: implemented

> 上游输入：总纲 `docs/plans/2026-10-19-architecture-supplement-plan.md` §2 D11 + §3 P5b、P5a ADR（`implemented/testing/2026-10-19-p5a-eval-infra.md` §Deferred）、RSI 计划 `docs/plans/2026-10-18-memory-skill-rsi-fitness.md` §3/§5。
> 开工前置已清：runner 归宿用户拍板 `src/services/`（2026-10-19 会话）；工时按 P5a 实测重估见 §工时重估。

## Problem

P5a 只交付零 ctx 代码：`evals/` 5 条种子、recall 接线、空表 `eval_cases`、防忘门。没有跑批，四臂（base/current/candidate/reflect）一次没开满，`compare.md` 零产出——发版门呈红（自 v0.19.0 起 27 三面文件无 compare），P6 注入决策门（D3）无数据可依。

## Decision

runner 住 `src/services/`（用户拍板），宿主平面手动触发工具 `evolve_eval_run` 为唯一在线入口，离线校验仍归 `scripts/eval-tasks.ts`。

**求解环路（单轮 loader 调用，D11=A 同一传输纪律）**：按臂定义（`solveDefinitionFor`，与线上同一系统位）经 subagent loader 单轮求解，复用 `llm-call` 路由（`ctx.get("agentDefaultModel")` 既有路径，不自建传输；机械门禁：`streamOnce` 只许 loader 碰，solver 走 loader）。四臂仅差注入上下文：base 空系统提示、current 复用 `buildSection` 真实渲染（与线上同一函数，保证测到的是真 lift）、candidate/reflect 首跑恒等于 current（无候选改动时如实记录，不伪造对照差）。判据本地执行：`output-contains` 子串、`file-exists` 只读存在性、`test-pass` 以超时上限跑任务自带命令（手动触发、仓库内 fixture，输出截断记账）。

**多轮 `tool_calls` 求解环路递延**：当前回归集 22 条全是记忆问答（单轮可解，rounds=1/tool_calls=0 如实记录）。触发条件：任务集出现第一条工具型任务时再做，候选宿主 subagent 带工具循环（Gotcha：用 `ctx.subagents`，不 inject workflowEngine）。递延不是砍：接缝留在 `solveSingleRound` 与按臂定义处，多轮实现即插即换，runner 不动。

**`--repeat 2` 与 flaky**：整批跑两次，同任务两次 `acc` 不一致标 `flaky` 并记报告；`rounds`/`tool_calls` 允许波动。

**judge（D10）**：任务臂与 judge 同一模型（用户真实配置）；judge 型 QA（recall B 段）独立判两次、一致才算，单独 report、不进 flaky。首跑 22 条全是确定性判据（无需 LLM judge），`judgeTwice` 协议与 QA recall-hit 检查先行落地，空 judge 集如实报告。

**预算**：每调用 `usage` 经 `normalizeUsage` 记账为 tokens；上限由工具参数 `budgetCapTokens` 传入（P5a 键契约冻结，不新增 `state` 键），超限记 `budget_exceeded`。首跑即实测：无 cap 时如实记录，供下次发版前折算。30 条上限（`EVAL_TASKS_MAX`）与 100% 全存沿 P5a。

**落盘**：`eval_cases` 行经 store 新方法 `writeEvalCases`（data 层纯函数已存在，store 只做薄委托）；`eval:last-four-arm` 按 P5a 契约写；`compare.md` 文本由工具输出返回，操作员拷入 `evals/runs/<date>/` 提交（`runs/` 全忽略、唯 compare 可交，P5a 语义不变）。

**运行时读盘**：npm `files` 增 `evals/tasks/*.json`、`evals/baseline/recall.json`、`evals/README.md`（pack 门禁只要求白名单非空匹配，相容）；runner 以 `import.meta` 向上定位 `evals/`，缺席即报可用性错误、不抛穿透。

**任务集 5→22**：每类记忆 ≥3 条、负例 ≥2、冲突 ≥2、`file-exists`/`test-pass` 各 ≥2；全部过 `eval:tasks` 离线校验（含 30 条上限）。

## Testing

- 新模块全配对测试（G9：豁免只减不增）：loader（缺盘/坏 JSON/上限）、solver（fake llm 三判据 + 超时）、judge（双次一致/不一致）、report（四臂 lift 表 + flaky 标记）、runner（fake solver 全臂 × repeat-2 + budget_exceeded + state 键）、tool（无工作区/干跑）。
- `eval:tasks --list/--dry-run` 在 22 条下仍过；`eval:recall` 基线同 PR 重锚（1→73.3%：新复述式查询暴露措辞失配缺口，检索代码未动，属正当重锚）。
- 发版门：首跑前仍呈红（预期内）；首跑 compare 入库后转绿。

## 工时重估（P5a 实测依据）

P5a 实测：`445a479` 单批 43 文件 +1636/-218（含 ADR v2–v4 三轮评审返工），零 ctx 代码。P5b 含 ctx 接线与求解执行，复杂度高于 P5a，拆分如下：任务集扩充 0.5 + runner core 五模块 1.5 + tool 接线与 mount 0.5 + 配对测试 0.75 + ADR/文档/收尾 0.25 ≈ **3.5 天**。总纲 24 人日占位符中 P5a/P5b 共拆 6.5 天：P5a 实耗约 2（含评审返工），P5b 取 3.5，**总数不变、无需对外改口**。

## Consequences

- 发版代价不变（P5a 既定）：带三面改动的发版先跑一次四臂；发版门在首跑 compare 入库前继续呈红，属预期内。
- 求解与判官走同一装载器：`streamOnce` 直调回归测试继续覆盖全部 `src/services`，新增 eval 模块自动受锁。
- 预算约束收紧处：store-types 零增长（双行合并换方法）、store.ts 出度已顶满 12——下一次 store 加方法前须先合边。
- P6 注入决策门（D3）的数据源就绪：首跑后 recall_hit/acc/cost 三数可在 compare 里直接读。
- 落地返工注记：求解初版直调传输层，被 `subagent` 结构性回归测试拦下（传输只许装载器碰），改走按臂定义 + 装载器（system 位 parity 保持；臂可变上下文住 eval 模块是刻意例外，静态表只收固定岗）；覆盖率门随后追平（assemble 挂载双路径、runner 判官/落盘失败分支、solver 不可达 catch 改删）。

## Alternatives considered

- **runner 住 `scripts/`（离线 tsx 直调模型）**：`scripts/` 拿不到宿主 ctx，需自建密钥保管与传输，D11 已判 B 落败；且 `scripts/` 不进 npm 包，桌面端实体拷贝无此文件。落败：归宿 `src/services/`。
- **求解环路首批即做多轮工具循环**：回归集无工具型任务，多轮循环零样本、不可测；且宿主 subagents 形态在桌面端未验证（同 P6 post-compact 条件项）。落败：接口预留 + 触发条件递延。
- **candidate/reflect 首跑伪造差异（如 current 加噪）**：对照差不可复现，违"有可执行验证器才算改进"。落败：恒等 current + 报告明示。
- **test-pass 判据在 runner 内禁执行（只支持两判据）**：任务集覆盖少一维，RSI 判据三件套缺角；手动触发 + 仓库 fixture + 超时截断下风险可控。落败：执行但设限。
- **eval_cases 行由工具输出经操作员手写入库**：多一手、多一错，且 P5a 契约"runner 写、卡片读"落空。落败：store 薄委托直写。
- **任务 fixture 打包进 lib（import JSON）**：fixture 与代码同版本是优点，但 22 文件 import 笨重、diff 噪声大；且 `evals/README.md` 方法文档应同行。落败：`files` 白名单增三项、运行时读盘。
