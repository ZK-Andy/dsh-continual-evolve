# 门禁缺口清单：把"人工反复校验"收编成机械校验

> 状态：**待实施**（2026-10-19 用户要求落盘）。本文是缺口批次唯一执行入口，与 [记忆/技能 RSI 任务级 fitness](2026-10-18-memory-skill-rsi-fitness.md) 分工互补：那份管"改动是否让任务变好"，本文管"改动是否守住架构"。
> 来源：2026-10-18 会话中"机械校验怎么校验架构 / 语义 / 形状 / 新增功能跑偏 / 多语言"的讨论结论，以及本仓库 13 个门禁脚本 + 108 份 ADR 的实测盘点。
> 纪律：**只新增 `scripts/verify-*.ts` 与 `test/fixtures/` 文件，不改现有门禁行为**；每条门禁必须配红绿俱验样本（见 §5），否则不算完成。

## 0. 一句话

现有门禁已覆盖 L0/L1 全层与 L4 的"证据存在"，缺 L2（契约快照）、L3（行为真实性）、L4（决策覆盖）三块共 12 条；本批次把这 12 条按"断言可写、收益可测"排序落地。

## 1. 分层模型与机械化边界

| 层 | 校验对象 | 机械可行 | 本仓库现状 |
|---|---|---|---|
| **L0 形状** | 文件位置/命名/大小/导出面/文件头 | ✅ 100% | ✅ 已有（R1–R4、src-budgets） |
| **L1 依赖** | import 边、环、分层方向、公共 API 面 | ✅ 100% | ✅ 已有（EDGES 白名单） |
| **L2 契约** | 类型签名、wire format、DB schema、白名单集合 | ✅ 95% | ❌ 缺（无快照） |
| **L3 行为** | 老行为是否还在、测试是否真在测 | ✅ 80% | ⚠️ 部分（覆盖率有，真实性无） |
| **L4 意图** | 改动是否符合架构决策 | ⚠️ 只查证据 | ⚠️ 部分（ADR 格式有，覆盖率无） |

**边界**：L4 的"意图正确性"不进机械校验，只在流程里留人工批准点（§7）。

## 2. 缺口清单（G1–G12）

| # | 门禁 | 层 | 收益 | 工作量 | 依赖 |
|---|---|---|---|---|---|
| G1 | ADR 覆盖率 | L4 | 高 | 0.5 天 | `change-scope` |
| G2 | 依赖环检测 | L1 | 高 | 0.5 天 | 无 |
| G3 | 门禁红绿俱验 | L3 | **最高** | 1.5 天 | 全部门禁 |
| G4 | 依赖预算棘轮 | L1 | 高 | 1 天 | src-budgets |
| G5 | 导出面快照 | L2 | 高 | 1.5 天 | ts-morph |
| G6 | Schema / 枚举快照 | L2 | 高 | 1 天 | node:sqlite |
| G7 | 文档历史词检测 | L0 | 中 | 0.5 天 | 无 |
| G8 | ADR Alternatives 质量 | L4 | 中 | 0.5 天 | adr-format |
| G9 | 测试-源码配对 | L3 | 中 | 0.5 天 | 无 |
| G10 | 变异测试抽样 | L3 | 高 | 1 天 | stryker |
| G11 | 函数形状规则 | L0 | 中 | 0.5 天 | ast-grep |
| G12 | 新目录归层白名单 | L4 | 高 | 0.5 天 | layering |

### G1 ADR 覆盖率

- **断言**：`change-scope` 的 changed 路径含 `src/**` 时，本次 diff 必须出现 `.agents/notes/*/**/*.md`；否则失败并提示"改行为需带 ADR"。
- **豁免**：纯 `docs/`、`test/`、`scripts/` 改动；或 PR 标签 `no-adr`（人工批准点）。
- **验收**：故意改一个 `src/*.ts` 不带 ADR → 红；补一份 ADR → 绿。

### G2 依赖环检测

- **断言**：`src/` 相对 import 图无环。EDGES 白名单只保证"每条边被登记"，不保证无环。
- **实现**：读 `verify-layering` 的 EDGES 结构直接建图，DFS 找环，输出环路径。
- **验收**：构造 `a→b→a` 的 fixture → 报告完整环路径。

### G3 门禁红绿俱验（铁律所在）

- **断言**：每条 `scripts/verify-*.ts` 配 `test/fixtures/gates/<gate-id>/{violation,clean}/`，违规样本必须非零退出、干净样本必须零退出。
- **反例优先**：先写违规 fixture 并确认门禁**确实红**，再写干净样本；顺序反过来会得到"永远绿"的假门禁（2026-10-18 governance shell 注入即此类）。
- **验收**：`pnpm check:gate-fixtures` 全绿；人为把某条门禁逻辑注释掉 → 该条 fixture 立刻红。

### G4 依赖预算棘轮

- **断言**：`baseline.json` 记录每模块 out-degree 与文件行数；只允许持平或下降，上升即失败并要求在 ADR 中说明。
- **验收**：把某模块依赖从 5 加到 6 → 红；删一条依赖 → 绿并自动更新 baseline（需显式 `--update`）。

### G5 导出面快照

- **断言**：ts-morph dump 每个 public 模块的 export 名与签名 → `snapshot/api.json`；diff 非空即失败，提示 `--update` 并需同 PR 的 ADR。
- **验收**：删一个 export → 红；改签名 → 红；只改实现 → 绿。

### G6 Schema / 枚举快照

- **断言**：`memories` / `extraction_log` 的列与 CHECK 约束、`verdict` 八值白名单、`injection_log` 字段 → dump 成 `snapshot/schema.sql` 比对。迁移脚本必须显式更新快照。
- **验收**：删一个 verdict 值 → 红；加一列不带迁移 → 红。

### G7 文档历史词检测

- **断言**：`docs/**`、`README*.md`、`.agents/notes/implemented/**` 命中 `previously|now |no longer|renamed|曾经|后来改成` 即失败（规则见项目 `AGENTS.md`「durable 文档写当前状态」）。
- **豁免**：`docs/upstream/**`、`release-notes.md`、`HANDOFF*`、`archive/**`。
- **验收**：fixture 里写一句含历史词的英文旧句式 → 红。

### G8 ADR Alternatives 质量

- **断言**：`## Alternatives considered` 下 ≥2 条 `- `，每条 ≥20 字；全为"不适用/无"视为空壳失败。
- **验收**：只写一条 → 红；写两条空话 → 红；两条实质内容 → 绿。

### G9 测试-源码配对

- **断言**：`src/**/x.ts` 必须有 `test/**/x.test.ts` 或登记在 `scripts/test-exempt.json`；豁免清单变更需 ADR。
- **验收**：新增 `src/foo.ts` 不写测试 → 红。

### G10 变异测试抽样

- **断言**：周任务对 `src/services/` 抽样跑 stryker，mutation score 门槛 60；低于门槛在 PR 评论里报，不阻塞合并。
- **理由**：覆盖率高不代表断言有效；变异测试是唯一能机械给出"测试是否真在测"信号的工具。
- **验收**：把某测试的断言改成 `expect(true)` → 该文件 mutation score 显著下降。
- **落地（2026-10-19 G10 收尾）**：`stryker.conf.json`（vitest runner + typescript checker，抽样 `prompt-date.ts` + `token-usage.ts`，thresholds break:null 永不阻断）+ `test:mutation` 脚本 + `.github/workflows/mutation.yml`（周一 02:00 UTC schedule + dispatch + services 变更 PR 触发；score 进 step summary、报告传 artifact、低于 60 才 PR 评论）。真实抽样 trial：59 秒跑完，86.49 分（token-usage 5 survived 真信号，prompt-date 100），19 个 CompileError 系 checker 正确过滤（类型非法变异不计分）；node:sqlite 插桩与 globalSetup 均已通过 trial 验证。接入坑两处：① stryker 10 的 `@stryker-mutator/*` glob 发现在 pnpm 隔离布局下扫不到兄弟插件（按 core 自身路径上溯）——配置改用仓库相对路径直载 `plugins`；② pnpm 沙箱 store 只读，装依赖走 `--store-dir` workspace 路径。抽样集轮换与 60 分基线复核留待周报跑顺后再定。

### G11 函数形状规则

- **断言**：ast-grep 规则集：参数 >4、返回 `any`、空 `catch {}`、`console.log` 进 `src/`（非 scripts）。
- **验收**：每类各一条 fixture，必须红。
- **实现注记（2026-10-19 G-batch3）**：引擎用 TypeScript 编译器 API（已声明依赖）而非 ast-grep 系统二进制——同四条纯语法规则，干净 CI 可跑，无新依赖；语义见 `scripts/verify-fn-shape.ts` 头注。另：真实树有 35 处历史形状，门禁按 G4 式棘轮基线落地（`scripts/fn-shape-baseline.json`，只收敛不发散），逐个重构签名超出门禁批次范围。

### G12 新目录归层白名单

- **断言**：`src/` 下新目录必须属于 `layers.json` 的允许集；不在集合内则失败，并要求同 PR 修改白名单（白名单变更 = 人工批准点，落 ADR）。
- **验收**：新建 `src/foo/` → 红；加白名单条目 → 绿。

## 3. 批次

> 2026-10-19 总纲修订（见[架构补充总纲](2026-10-19-architecture-supplement-plan.md) §3）：**G3 与 G6 抽出先行**（归总纲 P0）；剩余十条按 G-batch1/2/3 调度，命名以总纲为准（下文括号内的 P1/P2/P3 是本文档落盘时的临时编号，不再使用）。G-batch2/3 与总纲 P5 前段可并行。

- **G-batch1（2 天）**：G1 → G2 → G4。
- **G-batch2（2.5 天）**：G5 → G12 → G9。
- **G-batch3（2.5 天）**：G7 → G8 → G11 → G10（G10 需先评估 stryker 在 tsx/vitest 链上的接入成本）。
- 已抽出：G3（红绿俱验，1.5 天）与 G6（Schema/枚举快照，1 天）→ 总纲 P0 先行批。

## 4. 注册与门禁接入

- 新门禁统一 `scripts/verify-<topic>.ts`，遵守既有 `OK` 输出约定；
- 在 `scripts/run-gates.ts` 的 `docs` 模式里追加 `run("verify-<topic>", [...])`；
- 只读、无网络、无写入（`--update` 除外），失败退出码非零。

## 5. 铁律：红绿俱验

每条门禁必须先有**违规样本**并确认它变红，才允许接入 CI。没有违规样本的门禁，按"未实现"计。这是本仓库 2026-10-18 事故（governance 校验因 shell 注入恒 exit 0、从未真正执行）的直接教训。

## 6. Alternatives considered

- **只做 L0/L1（行数、命名、依赖）**：市面上多数工具停在这一层，但漏掉"契约被悄悄改"与"测试是假的"两类最贵的腐化。否。
- **引入现成框架（Nx / dependency-cruiser / ArchUnit）**：TS 侧可行，但会带来新构建依赖与第二套规则语言；本仓库已有 EDGES 白名单与 ts-morph 可用，自写 200 行更可控。否。
- **把 L4 意图也交给 LLM 判定**：可被 gaming，且与"模型提议、代码保证"的立场冲突。否。
- **先做多语言 IR + adapter**：现在只有一个仓库、一种语言，抽象过早；等第二个语言的真实需求出现再做（届时按 IR 四字段 + adapter 拆分）。否。
- **用提示词/规则文件约束 AI 行为**：软约束靠自觉，本批次的存在理由就是它不可靠。否。

## 7. 不进机械校验的人工项

| 人工项 | 理由 | 辅助手段 |
|---|---|---|
| 这个变更该不该做 | 价值判断 | 无 |
| 新模块属于哪一层 | 语义归属 | G12 只查"在不在允许集" |
| Alternatives 是否真诚 | 可查条数，查不了诚意 | G8 |
| 测试断言是否测真东西 | 覆盖率骗人 | G10 给信号 |
| 注入内容是否准确 | 语义正确性 | RSI fitness 回归集（另一份计划） |
| 是否发版 / 版本号 | 商业与风险判断 | CI 绿 + 三层核验是前置 |

## 8. 开工检查单

1. `pnpm typecheck && pnpm lint && pnpm test` 基线绿；
2. 按 §3 批次顺序，每条门禁：违规 fixture → 确认红 → 干净 fixture → 确认绿 → 注册 run-gates；
3. 每批次结束跑 `pnpm check:docs && pnpm check:handoff`；
4. 若某条门禁误报率 >10%，先降级为 warning 并在 ADR 记录原因，不硬上。
