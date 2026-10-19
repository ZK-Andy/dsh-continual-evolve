# 开发计划：记忆 / 技能 RSI 的任务级 fitness（评估闭环）

> 状态：**已拍板待实施**（2026-10-18 用户要求"整合成计划并落盘"）。本文是该批次唯一执行入口，供新会话按序施工。
> 背景调研：会话内已核实的生态盘点（GDPevo / Workspace-Bench / MemoryAgentBench / DSPy-GEPA / ACE / awesome-rsi），链接见 §4。
> 实施纪律：取舍已落 ADR [`2026-10-18-task-fitness-for-memory-skill-rsi`](../../.agents/notes/proposed/testing/2026-10-18-task-fitness-for-memory-skill-rsi.md)；每阶段独立提交、测试全绿；**P0–P2 只新增文件，不改 `src/` 行为**。

## 0. 一句话

给本插件补上它唯一缺的东西：**一条能判定"这次改动到底让记忆/技能变好了没有"的任务级 fitness 线**——用自建的 20–30 条真实任务回归集，按 GDPevo 的四臂定义和五指标口径跑批，结果进报告、进发版前置门禁。

## 1. 为什么是这件事

插件当前的进化是**机制驱动**的：事件驱动评审、分层提级与 30 天实习、注入账本、token 预算三档、提案预筛、`notWhen` 负条件——每条都有 ADR，但没有一条有"带来多少增益"的测量。继续加机制而不加测量，半年后无法判断哪条该留。

已有的度量只有两处，都是**代理指标**：

- `scripts/eval-recall.ts`：只测索引召回（`recall@1/3`），不测任务结果；
- 注入账本 + 近 7 天转化率：只测"注入过的条目被用到"，不测"用到之后任务是否更好"。

RSI 与研究界那条线的分界就在此：**有可执行验证器才算改进，否则只是变化**。

## 2. 目标与非目标

**目标**

1. 冻结一套私有回归集：20–30 条来自真实会话的任务，每条含输入、期望行为、**可执行判据**（文件存在 / 测试通过 / 输出含关键断言）。
2. 建四臂跑批：`base`（无注入）/ `current`（当前注入）/ `candidate`（候选改动）/ `reflect`（候选 + 评审反馈再迭代一轮）。
3. 出五指标报告：成功率、轮次、工具调用数、token 成本、lift（相对 `base`）。
4. 接门禁：改动 memory/skill 机制的 PR 必须附一次四臂结果；CI 出报告但不阻塞。
5. 外部锚点：每季度跑一次 MemoryAgentBench 的 AR/CR 子集与 Workspace-Bench-Lite，防止自建集过拟合。

**非目标**

- 不刷公开 benchmark 排名，不追 SOTA；
- 不做模型权重训练，不做 post-training；
- 不引入 LLM 自评作为唯一 fitness（只允许作辅助，且要求双 judge 一致）；
- 不改动 `src/` 的既有行为（P0–P2 全是新增文件）；
- 不做自动发版（发版仍走人工批准）。

## 3. 指标口径（照抄 GDPevo，外加三项记忆专有）

| 指标 | 定义 | 数据来源 |
|---|---|---|
| `acc` | 任务通过率（判据全过才算通过） | 判据执行结果 |
| `rounds` | 每任务平均模型响应轮次 | 会话轨迹 |
| `tool_calls` | 每任务平均工具调用次数 | 会话轨迹 |
| `cost` | token 折算成本（按会话 `usage`） | `extraction_log.usage` 同形状 |
| `lift` | `acc(臂) − acc(base)`，同批任务 | 上表推导 |
| `recall_hit` | 该任务相关记忆是否出现在注入索引里 | 注入账本 `injection_log` |
| `conflict_ok` | 冲突场景下是否采用最新判定（对应 MemoryAgentBench 的 CR） | 判据断言 |
| `repeat_err` | 同类错误在后续任务中是否复现 | 判据断言 |

**判据优先级**：可执行断言 > 结构化比对 > 人工 rubric > LLM judge。前两档判不了的任务不进入回归集。

## 4. 参照（外部链接，只借鉴方法，不引依赖）

- GDPevo（四臂定义与五指标）：<https://github.com/Prism-Shadow/GDPevo>
- Workspace-Bench（dsh runner 适配与 rubric 组织）：<https://github.com/OpenDataBox/Workspace-Bench>
- MemoryAgentBench（AR / TTL / LRU / CR 四能力）：<https://github.com/HUST-AI-HYZ/MemoryAgentBench>
- DSPy GEPA（有 metric 后的指令自动优化，P4 可选）：<https://dspy.ai/current/getting-started/gepa-optimization/>
- Awesome-RSI（判断本项目在生态中的位置）：<https://github.com/lobehub/awesome-rsi>

## 5. 阶段

### P0 冻结回归集（0.5–1 天）

- 新建 `evals/tasks/*.yml`，每条：

```yaml
id: task-001
from: session-<id>#seq-<range>      # 溯源，可为脱敏占位
prompt: |
  <脱敏后的任务输入>
expect:
  - kind: file-exists
    path: "<相对路径>"
  - kind: test-pass
    cmd: "<命令>"
  - kind: output-contains
    any: ["<关键断言>"]
tags: [memory, conflict, skill]
```

- 判据覆盖率必须 100%（无判据的任务不入集）；每类记忆至少 3 条，含 1 条负例（不该被注入的干扰项）。
- 交付：`evals/tasks/`、`evals/README.md`（格式 + 脱敏规则 + 维护周期）。
- 验收命令：`pnpm eval:tasks --list` 输出任务数与判据类型分布；`--dry-run` 不发起任何模型调用。

### P1 单臂跑批骨架（1–2 天）

- 新增 `scripts/eval-tasks.ts`：读任务集 → 以当前配置跑一次 `base` 臂 → 落 `evals/runs/<date>-<arm>/report.json`。
- `report.json` 固定 schema：`{ arm, started_at, commit, plugin_version, tasks: [{id, pass, rounds, tool_calls, usage, judge}], totals: {acc, rounds, tool_calls, cost} }`。
- 可复现性：同批跑两次，`rounds`/`tool_calls` 允许波动，`acc` 必须一致；不一致的任务标 `flaky` 并记录。
- 验收：两条命令产出的 `totals.acc` 相同；单次全批成本记录在报告里。

### P2 四臂对照（2–3 天）

- 四臂定义照 GDPevo：`base` / `current` / `candidate` / `reflect`；每臂同批任务、同一 solvers 模型、同一宿主版本。
- 输出 `evals/runs/<date>/compare.md`：五指标 + 三记忆指标的 lift 表，附每任务成功/失败的差异清单。
- 验收：`compare.md` 里每个指标都有 `base` 与至少一个实验臂的对照，且标注样本量与标准差。

### P3 接门禁（1 天）

- `run-gates.ts` 增一条**非阻塞**检查：若本次 diff 触及 `src/` 的记忆/技能/注入模块，则要求 `evals/runs/<date>/compare.md` 存在，缺失时输出警告（不失败）。
- 发版流程（`release-flow`）增加人工项：附一次四臂结果，否则不发版。
- 验收：故意删掉 `compare.md` 跑 `pnpm check:docs`，得到 warning 而非 fail；CI 仍绿。

### P4 外部锚点与可选自动化（持续）

- 每季度跑一次 MemoryAgentBench 的 AR/CR 子集 + Workspace-Bench-Lite，作为外部漂移检查，不与自建集混算。
- 可选：用 GEPA 以自建集的 `acc` 为 metric 自动生成注入指令变体，产物先落 `candidate` 臂验证，再人工拍板是否进 `src/`。
- 验收：外锚报告落 `evals/runs/external-<date>.md`，一年至少两份。

## 6. 成本与隐私

- 回归集规模上限 30 条，每臂单次，防止成本失控；`--subset` 支持临时只跑 10 条。
- 任务输入只存**脱敏后**文本，会话 id 与 seq 区间作为溯源占位，不存用户私有原文。
- `evals/runs/` 默认 `.gitignore`，只提交 `compare.md` 的汇总行与结论（数字进仓库，明细留本地）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 样本太小，结论是噪声 | 任务 ≥20；每任务 `acc` 不一致即标 `flaky`，先修判据再入表 |
| 回归集腐化（只对旧任务有效） | 每季度替换 20%，替换比例写进 `evals/README.md` |
| 判据写不出（主观任务） | 直接不入集，不用 LLM judge 硬凑；主观维度只作观察项落后 `OBSERVATION.md` |
| 成本超预期 | 每批设 token 预算上限，超限即中止并记 `budget_exceeded` |
| 优化器过拟合自建集 | 外锚季度跑；`candidate` 必须在未见任务上复验 |

## 8. 交付物清单

```
evals/README.md                     # 格式、脱敏、维护周期
evals/tasks/*.yml                   # 20–30 条回归集（私有）
scripts/eval-tasks.ts               # 跑批 + 报告（P1）
evals/runs/<date>/report.json       # 单臂结果
evals/runs/<date>/compare.md        # 四臂对照（仓库只留这份）
scripts/run-gates.ts                # +1 条非阻塞检查（P3）
docs/plans/2026-10-18-memory-skill-rsi-fitness.md   # 本文
```

## 9. Alternatives considered

- **直接用公开 benchmark 当 fitness**：分布不匹配——GDPevo 是 CRM/ERP/金融业务任务，Workspace-Bench 是大文件工作区，都测不到"个人记忆插件在跨会话偏好上的增益"。否。
- **只扩 `eval-recall.ts` 的召回指标**：召回是代理，召回率高但注入位置/表述变差时任务结果可能更差。否，仅作辅助指标。
- **先上 GEPA 自动优化指令**：没有任务级 metric 时优化器无从优化，会把"改得更像训练集"当成改进。否，放到 P4。
- **LLM 自评当 fitness**：可被 gaming，且与"模型提议、代码保证"的既有立场冲突。否，仅作辅助且需双 judge 一致。
- **不建回归集，靠 OBSERVATION 人工观察**：无法证伪，也无法进 CI。否。

## 10. 开工检查单

1. `pnpm typecheck && pnpm lint && pnpm test` 基线绿；
2. 复核 ADR（`proposed/testing/2026-10-18-task-fitness-for-memory-skill-rsi.md`）与本文是否仍有分歧，有分歧先改 ADR；
3. 从 P0 开始，每阶段独立提交，附该阶段验收命令的实跑输出；
4. 任何阶段发现判据不可执行，就地缩小任务集，不降判据标准。
