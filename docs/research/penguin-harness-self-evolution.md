# penguin-harness 自进化机制研究报告

> 研究对象：[Prism-Shadow/penguin-harness](https://github.com/Prism-Shadow/penguin-harness)（Apache-2.0 / TypeScript，2026-07-19 创建，v0.2.2 于 2026-08-11 发布，1.2k stars）
>
> 结论先行：**该机制是纯提示词契约实现，代码零硬校验，仅适合作为研究性项目参照，不可直接借鉴到生产环境。可借鉴上限 = 概念骨架 + 硬化改造清单。**

---

## 1. 项目定位

PenguinHarness 是一个桌面端"自动化 Agent 构建器"（macOS / Windows / Linux，Electron），核心主张：

1. 一句话生成完整 Agent 应用（自称生成一个 RAG 应用仅耗 \$0.02 token，跑在 DeepSeek V4 Pro 上）
2. 自进化机制（Skills）：Agent 自己跑 benchmark、找失分点、发布 N+1 版本
3. 深度适配开源模型（DeepSeek V4 / Kimi K3 / GLM 5.2 / Hunyuan 3 / Qwen 3.8 Max）

仓库结构（packages/）：

```
core/      Agent 引擎、状态管理、Trace 写入（低层接口 + 最小工具集）
skills/    4 组内置 Skill 定义（SKILL.md 契约，含自进化三件套）
desktop/   Electron 桌面端（分发入口）
web/       管理界面（Agent 列表、Benchmark 页、Trace 查看）
server/    本地服务端（含 benchmark 展示服务）
cli/       命令行入口（penguin run ...）
docs/      文档（self-improvement 章节为自进化设计说明）
```

## 2. 自进化机制全解

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│ 契约层（逻辑所在，全部是 SKILL.md 提示词，无硬编码）          │
│  benchmark-design  → 设计/校准 Benchmark，冻结 Baseline    │
│  agent-evaluation  → 隔离执行 + 私下评分，输出协议 YAML     │
│  agent-optimization→ 证据→假设→候选→评估→接受/回滚循环      │
│  agent-creation    → 一句话生成 Agent 应用                │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ 状态层（文件系统即数据库）                                   │
│  agents/<id>/agent_state/          system_config.yaml(含  │
│                                     version 优化计数)、   │
│                                     AGENTS.md、skills/    │
│  agents/<id>/benchmarks/<bid>/     benchmark_config.toml │
│                                     scoreboard.yaml      │
│                                     CASE-<n>/statement/  │ ← 公开
│                                     CASE-<n>/rubric/     │ ← 私有
│  agents/<id>/snapshots/v<N>.tar.gz  每轮修改前原子快照      │
│  agents/<id>/traces/                会话 Trace（可审计）   │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ 执行层（基础设施）                                          │
│  run_subagent    并行分发评估单元、收集协议响应              │
│  penguin run CLI 以隔离 workspace 启动被测 Agent          │
│  Trace 绑定      根会话 → provider/model 可验证            │
└─────────────────────────────────────────────────────────┘
```

### 2.2 进化循环（agent-optimization 每一轮）

```
① 建立 Reference
   当前最优 Agent State + 其在该 Benchmark 上的完整评估
② 诊断能力缺口
   只基于公开 Statement + 各 Case 得分 + Trace（黑盒观察）
   用重复 Run 区分「稳定行为」与「随机波动」
③ 陈述可证伪假设
   必须预测「哪些可观察决策/产物会变、为什么变」
   只加分析步骤、不预测行为变化的改动 → 拒绝
④ 构建 Candidate（从 Reference 派生）
   改动载体限定三类：AGENTS.md 行为指导 / 新增 Skill / system_config 安全限制
   版本号 = Reference + 1，只增不复用
   动手前必须已有 snapshots/v<Reference>.tar.gz（无则先建）
⑤ 可接受性检查
   改动需 general、不得使用私有评估信息、只允许改允许的范围
⑥ 并行评估
   Case × runs 矩阵全部单元委托 agent-evaluation 子代理，
   每单元独立 workspace、独立评分、独立协议输出；
   评估运行时(provider/model/thinking_level)全程冻结
⑦ 决策
   接受 ⇔ 评估完整有效 ∧ 顶层平均分严格高于 Reference
   否则原子回滚（还原文件 + 版本号，删除候选残留）
⑧ 记录与续行
   接受即追加 scoreboard.yaml 并回读验证；
   达目标分或轮次上限停止；失败码条目不计轮次
```

### 2.3 评估协议（agent-evaluation 与调用方的通信契约）

请求（run_subagent 调用方下发，每单元一条）：

```text
Use the `agent-evaluation` Skill. Run the specified Test Agent
on the specified Case exactly once, then score that single execution.
protocol_version: 1
case_id: <case_id>
run: <1_based_run_index>
expected_version: <test_agent_state_version>
test_agent_id: <test_agent_id>
benchmark_id: <benchmark_id>
provider: <provider>
model_id: <model_id>
```

成功响应（evaluator 只允许输出这一份纯 YAML，禁止任何旁白）：

```yaml
protocol_version: 1
status: ok
case_id: <case_id>
run: <run>
expected_version: <version>
provider: <actual_provider>     # 必须从根 Trace 的 session_meta 读实际值
model_id: <actual_model_id>
thinking_level: <configured_thinking_level>
score: <0_to_100>               # 两位小数
cost: <number_or_null>
duration_ms: <非负整数>
session_id: <test_session_id>
```

失败响应使用四个稳定失败码：

| 失败码 | 语义 |
|---|---|
| `invalid_request` | 请求不完整/字段冲突（不执行，不建 workspace） |
| `benchmark_invalid` | Statement 或 Rubric 与契约冲突，无法应用评分 |
| `version_changed` | Agent 版本与请求不符或评估期间被改动 |
| `evaluation_failed` | 启动无法安全修复 / Trace 绑定失败 / 评分失败 |

防污染规则（确保"能测的"与"被测的"分离）：

- 被测 Test Agent 可见：Statement、自己的 State；不可见：Rubric、Gold、评分规则
- 评估者可见：隔离 Workspace、根 Trace、私有 Rubric；不可见：其他 Agent、凭据
- Optimizer 可见：Statement、得分、Trace；不可见：Rubric、Gold、评估者内部推理——若私有信息进入 Optimizer 上下文，判定污染，废弃当前 Candidate 并停手

### 2.4 Benchmark 结构与校准

每个 Benchmark：

```
<bid>/
├── benchmark_config.toml      # title/description/runs=1（设计阶段固定单 Run）
├── scoreboard.yaml            # evaluations: []（进化历史）
└── CASE-<nnn>-<name>/
    ├── statement/README.md    # 公开：目标、材料、必需产物
    └── rubric/README.md       # 私有：评分项 + 分值 + Gold，满分恒 100
```

校准流程（benchmark-design）：

1. 先写 Capability Contract：测什么可观察流程、典型弱行为、期望训练出的通用 State 改进
2. 每个 Case 私有记录：预期行为、强 Agent 可能的捷径、两者在哪个被评分的决策/产物上分道扬镳
3. 首轮 Pilot（每 Case 单 Run）当作探针：观察被测 Agent 如何理解任务、如何抄近路
4. 多轮 Pilot 迭代校准难度 → 冻结首个达标的修订 → 记录为 Formal Baseline（此后不再回填、不重跑）
5. 泄漏检查：公开文件不得泄露 Gold / 私有评分条件 / 解题暗示

## 3. 核心设计点与借鉴分析

| # | 设计点 | 优点 | 缺点 | 硬化后适用场景 |
|---|---|---|---|---|
| 1 | **评估隔离**（evaluator 独立运行+私下评分，model 分层） | 模块化防泄漏，职责单一 | 隔离靠提示词自觉，无权限强制 | 有子代理 + workspace 隔离能力的框架 |
| 2 | **固定评估运行时**（provider/model/thinking_level 冻结，runtime 不符即无效） | 保证版本间分数可比 | 校验依赖 evaluator"自查 Trace" | 评分前由运行时强制比对会话元数据 |
| 3 | **可证伪假设**（每轮必须预测可观察行为变化） | 阻止无意义的 prompt 堆叠，循环有方向 | 假设质量无客观标准 | 搭配人类 review 门禁，作为评审清单 |
| 4 | **快照回滚纪律**（改前快照、版本只增、拒绝即原子还原） | 循环完全可逆，安全网 | 打包指令由模型执行，可被跳过 | 文件写前由运行时自动快照（钩子化） |
| 5 | **协议化子代理通信**（纯 YAML + 稳定失败码 + 重试规则） | 输出机器可解析，故障分类清晰 | 协议字段无代码校验 | 加 schema 校验层，非法输出即失败 |

## 4. 软契约稳定性分析（关键结论）

### 4.1 实证：代码层零硬校验

- `protocol_version` 全仓库仅出现在 3 个 SKILL.md 文件，**无任何代码引用**
- `packages/server/src/services/benchmark-service.ts` 自述 "read-only display"：只做展示用 shape 校验，**"never recomputes aggregates"**，scoreboard 中的平均值是模型自行写入的（"model-written averages"），代码不重算、不校验
- 以下关键纪律全部是提示词指令，无代码钩子：
  - 修改前打包快照（.tar.gz）
  - 污染自查（"若私有信息进入上下文，废弃候选"）
  - Trace 比对（provider/model 一致性由 evaluator 自己"检查"）
  - 成绩合法性（0..100 由模型自觉遵守，代码只在 UI 展示层兜底形状）
- 存在的硬保障仅限工具执行层外围：Agent/Skill ID 白名单正则（防路径穿越）、workspace 路径规范化校验、命令执行限制等

### 4.2 失效模式（无代码兜底）

| 失效模式 | 表现 | 后果 |
|---|---|---|
| 评分污染 | Optimizer 私引 rubric 信息 | 表面分数虚高，模型并未真变强 |
| 分数伪造 | Evaluator 编造分数/session_id（自产自审） | scoreboard 失去可信度，回归决策失真 |
| 版本检查跳票 | 跳过 version_changed 检查 | 用旧版本评估结果冒充新版，rollback 错位 |
| 回滚欺骗 | 拒绝的 Candidate 未真正还原 | 污染下一轮 Reference，循环渐进退化 |
| 基准漂移 | 评估期间 Statement/Rubric 被改动 | 分数不可比 |

### 4.3 根因

逻辑被放在 SKILL.md（LLM 可读、可被 LLM 改写）里是**刻意的设计取舍**——README 宣称"模型与 Harness 共同进化"，希望 Harness 自身成为模型可改进的对象。代价是：**整个闭环的完整性 = 单点信赖 orchestrator 的指令遵循能力**。重复运行不可复现，同样输入可能演化出完全不同的"最优版本"。

## 5. 结论：仅适合研究，生产化改造路线

### 5.1 定性

- 作为**研究性项目**：价值很高——它是"LLM 驱动 self-improvement"这一前沿方向的完整示范，且实现极简（文件系统 + 提示词），极易整体读懂
- 作为**生产方案**：不合格。确定性要求（评分可审计、回滚原子、防泄漏不可能发生）在软契约下无法保证

### 5.2 可借鉴上限

1. **循环骨架**（证据→可证伪假设→候选→评估→接受/回滚）是科学方法，与具体实现无关，可直接沿用
2. **状态模型**（version 计数 / scoreboard 全历史 / 快照目录）是好的文件布局，可参照
3. **协议文本**（协议 YAML + 4 失败码 + 重试规则）可作 schema 设计起点

### 5.3 生产化改造清单（硬契约化）

| 软约束（原实现） | 硬化改造（代码强制） |
|---|---|
| Evaluator 输出自审"是纯 YAML" | 代码层 schema 校验：字段白名单、score∈[0,100]、失败码枚举，非法即重试/判失败 |
| Optimizer 自觉先建快照 | 文件写入钩子：运行时在修改 Agent State 前自动打包，模型无权跳过 |
| Evaluator 自查 Trace 绑定 | 运行时比对 session_meta 的 provider/model 与请求字段，不匹配直接判无效 |
| Optimizer 自觉不看 rubric | 权限隔离：rubric 目录对 Optimizer 不可读（ACL/独立服务），靠权限不靠自觉 |
| 模型自评平均分写入 scoreboard | 聚合计算下沉代码，模型只产出细胞级分数 |
| 格式/遗漏等机械扣分 | 确定性脚本评分，模型仅保留语义分 |
| — | 全程人工门禁：Candidate 上评估矩阵前必经 review（保底） |

改造后的架构即：**LLM 只负责产生假设与语义判断，一切可机械化的保障全部代码化**——这与其"研究性原型"定位吻合，也符合"契约必须稳定"的理念。

## 6. 参考资料

- 机制契约（核心）：
  - `packages/skills/skills/agent-evaluation/SKILL.md`（v5，评估协议）
  - `packages/skills/skills/agent-optimization/SKILL.md`（v9，进化循环）
  - `packages/skills/skills/benchmark-design/SKILL.md`（v7，基准校准）
  - `packages/skills/skills/agent-creation/SKILL.md`（Agent 生成）
- 状态与版本：
  - `packages/core/src/state/agent-state.ts`（Agent State 装载，版本计数）
  - `packages/core/src/state/kernel-history.ts`（kernel 版本哈希历史，`version` 为优化计数）
  - `packages/core/src/state/example-benchmark.ts`（示例 Benchmark）
  - `packages/core/src/state/default-config.ts`（system_config.yaml 模板）
- 执行与展示：
  - `packages/server/src/services/benchmark-service.ts`（只读展示，明确不做聚合校验）
  - `packages/server/src/http/routes/benchmarks.ts` / `skills.ts`
  - `packages/core/src/environment/tools/run-subagent.ts`、`subagent/*`（子代理分发）
  - `packages/core/src/trace/writer.ts`（Trace 写入）
- 文档：
  - `packages/docs/content/self-improvement.en.md` / `.zh.md`（官方自进化设计说明）

---

*研究日期：2026-08-13。依据仓库 main 分支（v0.2.2 后）现场核查：协议字段无代码引用、benchmark-service 仅做展示校验、快照/防污染/Trace 比对均为提示词指令。*