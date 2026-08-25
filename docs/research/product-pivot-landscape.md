# 产品形态探索报告：从「对话内进化」到「进化的信任层」

> 2026-08-24 探索会话产物，竞品数据截至当日。定位方向已采纳（用户拍板），**未立项**——实现计划、ADR 与代码变更均未启动。配套背景：[design.md](../design.md)（引擎设计）、[gap-analysis.md](../gap-analysis.md)（2026-08-17 差距分级）。

## 1. 问题定义

插件形态下，进化只在对话内发生，效率与效果存在七个结构性约束：

| # | 约束 | 证据 |
|---|---|---|
| 1 | 进化带宽 = 对话带宽：触发全部挂在会话事件上 | 门禁每 6 回合一次且重启清零（FAQ #5） |
| 2 | 单一输入源：只看得见本 harness 的会话轨迹 | 设计 §4 触发源清单 |
| 3 | 人在环是打断式的：审批弹窗卡吞吐 | fate/wrapup 冷却机制即为防打扰而设 |
| 4 | 评估本身占用对话，证据无独立通道 | OBSERVATION 多项 `[待观察]` 停滞数周 |
| 5 | 效果不可归因：机制成立但加速不可度量 | D2 bootstrap 实验（OBSERVATION 2026-08-19） |
| 6 | 因果链太长：条目→注入→行为，间接两层 | 存在性 case 天花板低的行为型 case 教训 |
| 7 | 进化结果不可见：只有命令与弹窗两个窗口 | store 为本地 JSON，无持续观测面 |

结论：治理层已完成（版本化/回滚/门禁/benchmark），瓶颈转移到"进化学费与度量"。继续在插件形态内加命令边际递减。

**决策输入**：目标用户为对外发布；进化输入源最小闭环取 DSH 会话存储（事件溯源 JSONL，稳定 `seq` 编址可直接复用为 ingest 游标）。

## 2. 调研方法

四簇并行扫描（离线优化器 / 记忆层产品 / 自进化框架 / 控制台先例），GitHub 一律 gh CLI 六步配方（发现→验健康度→README→trees，禁全量克隆），非 GitHub 信息 web 检索补充。健康度核验：创建日期 vs 星增速、贡献者数、fork 比、最近 push；存疑项目单独标注不进主推荐。

## 3. 市场格局（数据截至 2026-08-24）

### 3.1 离线优化器：候选生成与评测耦合的工具

| 项目 | 星级 | 形态 | 循环组织 | 治理面 |
|---|---|---|---|---|
| gepa-ai/gepa | 6.2k | Python 库，UI 外挂生态（gepa-viz 第三方） | 轨迹反思→定向变异→minibatch 评测→Pareto 前沿选择 | 无 |
| stanfordnlp/dspy | 37.6k | 优化器即库类；观测外挂 MLflow/Weave | 指令提案+贝叶斯采选 / introspective 扰动 | 无 |
| zou-group/textgrad · microsoft/trace | 3.7k / 0.8k | 研究型纯库 | 文字"梯度"反传 / 计算图重写；贪心单线接受 | 无 |
| openevolve（AlphaEvolve 开源复现） | 7.3k | pip+CLI | MAP-Elites 分桶存档+多岛；checkpoint/trace 全落盘但无交互界面 | 无 |
| promptfoo（已被 OpenAI 收购，核心仍开源） | 24.5k | CLI+本地 viewer+GH Action+企业云 | 只有评估半环；PR 级 before/after 对比门禁 | 无生成侧 |

要点：全簇产物是丢弃型工件，接受即终点——无一具备版本语义/审计链/回滚。行业正从"一个标量分"走向"结构化失败说明"（与我们两段式评估同向）。NousResearch/hermes-agent-self-evolution（★5.2k，ICLR'26 Oral）验证「会话轨迹→eval 集→GEPA 进化→PR 回写」路线可行且廉价（$2–10/run），但绑定单一 agent、以 git PR 为界。

### 3.2 记忆层产品：三层漏斗的形态谱系

| 项目 | 星级 | 形态 | 进化机制 | 备注 |
|---|---|---|---|---|
| letta-ai/letta-code | 3.1k（主仓 24.4k 已归档转向） | agent 服务器+桌面+ADE 控制台+云 | sleep-time compute 后台改写记忆；MemFS 用 git 版本化；agent 自装 skills | 最接近自进化；锁自家运行时/云账号 |
| mem0ai/mem0 | 64k | Library/Self-host(+dashboard)/Cloud 三档 | v3 转 ADD-only 提取+读时消解（实体链接+多信号检索+时间排序）；开源评测框架 memory-benchmarks | Apache-2.0（ELv2 疑虑不成立）；护城河在平台效果差 |
| getzep/graphiti | 30.3k | 时序上下文图引擎+MCP server | bi-temporal 边失效窗口保留完整演化史 | 天然审计友好；Zep CE 已弃用转云（前车之鉴） |
| topoteretes/cognee | 30.2k | 库+SDK+Cloud | ECL 管线显式化（add/cognify/search）；session 缓存后台固化 | 管线阶段命名可借鉴 |
| langchain-ai/langmem | 1.6k | 纯 SDK（半停滞维护态） | hot path vs background 双通道记忆形成 | 双通道 API 切分范式可借鉴 |
| basicmachines-co/basic-memory | 3.7k | local-first MCP server（AGPL-3.0） | 人/agent 直读直编 Markdown，策展即编辑 | 人机共用可读制品使信任问题消失大半 |

要点：全部收敛为「开源引擎→自托管服务(+dashboard/MCP/CLI)→托管云」漏斗；对外发布标配四件套=SDK+CLI+MCP server+Web 控制台。无人以 harness 自身状态（prompt notes/skill/subagent spec）为记忆对象——记的全是用户/对话知识。

### 3.3 自进化框架：训练侧退潮，scaffold 侧爆发

参照物十日变化（2026-08-14 → 08-24）：

- **PrimeIntellect-ai/prime-agent**（★18.2k，≥100 贡献者）：55 commits，连发 v0.7.4/v0.8.0；新增 `session_before_refine` 扩展钩子把进化循环平台化为扩展点；治理面仍留白。双刃：既是潜在宿主渠道，也预示"能进化"将被主流 harness 吸收。
- **Prism-Shadow/penguin-harness**（★1.6k，贡献者 13，星速异常已标注）：**已完成产品化闭环**——macOS/Win/Linux 安装包、官网、npm、Product Hunt 发布，8 月连发 5 个 release。卖点"run the benchmark, find the lost points, ship version N+1"与本项目主张近乎逐字重叠；有每轮快照+Trace+semver changelog 雏形，但无 benchmark 通过门禁、无细粒度对象回滚，roadmap 的 "Company-level self evolving" 未打勾。

新框架主推荐（验真通过）：lsdefine/GenericAgent（★14k，skill tree 生长叙事，零治理）；EvoScientist/EvoScientist（★4.5k，memory→AutoSkills 定时蒸馏+人审提交，pip+WebUI 雏形——机制上与本项目的 notes→skills 最接近）；EverMind-AI/Raven（★3.6k，公司背书的 memory-first harness）。存疑剔除：HyperAgents（3 贡献者+禁商用）、AgentEvolver（停更 4 月）、dgm/R-Zero/AZR/Agent0（训练侧研究代码，集体停更）。

完成"安装包+界面"产品闭环的只有 penguin-harness 一家。

### 3.4 控制台先例：信息架构与打包共识

| 项目 | 星级 | license 划界 | 可搬运设计 |
|---|---|---|---|
| langfuse/langfuse | 33.6k | MIT core + `/ee` 目录 license key | 六段式导航；prompt 不可变版本+label 指针 deploy/rollback；annotation queue 人审队列 |
| Arize-ai/phoenix | 11.2k | 已转 Elastic License 2.0 | OTel/OpenInference 语义约定；span→dataset→experiments 闭环 |
| AgentOps-AI/agentops | 5.8k | SDK MIT + 平台 ELv2 | session 回放 + timetravel 重演叙事（五家独有） |
| braintrustdata（闭源云） | — | 纯云，self-host 仅企业 data plane | 一切产物锚定不可变 prompt 版本的资产血缘 |
| helicone/helicone | 6.1k | Apache-2.0 全开 | 网关旁路接入；按 user/provider/property 下钻面板 |

一级模块六段式共识：Traces/回放 · Prompts 版本+Playground · Datasets&Experiments · Scores/人审 · Dashboards · Settings。最小可行控制台：单容器/compose 起、SQLite 默认、本地优先无强制云账号。

## 4. 交叉结论

1. **三簇独立指向同一空白：进化治理层。** 优化器无版本语义；记忆产品不记 harness 状态；自进化框架治理留白。「benchmark 门禁决定接受/拒绝 + 多类对象统一版本库 + 全链路审计 + 细粒度回滚」的组合至今无人完整实现。
2. **时间窗约 1–2 个季度。** penguin-harness 已抢注"benchmark 驱动自进化构建器"的产品叙事并完成冷启动；其企业级治理空位是剩余差异化窗口。同时 prime-agent 平台化预示纯"能进化"功能一年内贬值为主流标配。
3. **形态共识与对外发布兼容。** 本地优先引擎 + 四件套 + open-core `/ee` 划界；全行业无人把进化闭环做成云端 SaaS——私有轨迹的信任壁垒是硬约束。前车之鉴：Zep 承诺 self-host 又收回。

## 5. 定位决策：「进化的信任层」（已采纳）

> 不做第 N 个 self-evolving agent builder，做让自进化可以被信任、被采纳的控制平面。
> 分工：self-evolving agent builder 们负责让 agent 进化；本项目负责让进化可信。

**做**：多类 harness 状态对象的统一版本库 + 细粒度回滚；benchmark 门禁驱动的接受/拒绝（含变更前后对比门禁语言）；全链路审计与轨迹重演；审批队列；人类可直读直编的策展面；自带 eval。
**不做**：通用 agent 运行时（不自建 harness）、云端托管进化闭环（信任壁垒）、训练侧改权重。

**三支柱差异化**：
1. 四类对象统一版本库 + 细粒度回滚（无人有）
2. benchmark 门禁决定接受/拒绝——两段式评估、rubric ACL、失败格协议、非退化规则均为存量能力
3. 全链路审计 + timetravel 式轨迹重演（控制台先例中仅 AgentOps 涉足，正对"从轨迹沉淀状态"的天性）

**产品形态**：本地优先常驻引擎（ingest→distill→review→apply→measure 异步流水线）+ Web 控制台（六段式导航映射：条目库 / refinement 版本 diff+label 回滚 / scoreboard 实验 / 审批队列 / 使用-陈旧度量面板 / 设置）+ CLI + MCP server。

**输入源张力解法**：适配器架构——定义通用轨迹格式；DSH 会话存储为第一个 adapter（自用验证），外部用户经 adapter 接入自家 agent 轨迹（hermes 案例证明此类轨迹可得且廉价）。

**包装原则**：MIT/Apache core + `/ee` 增值（团队审计导出/RBAC）；本地优先无强制云账号；永不收回 self-host 承诺。

## 6. 风险

| 风险 | 应对 |
|---|---|
| penguin 补齐企业级治理（窗口 1–2 季度） | 立项后尽快出最小可信发布物卡位 |
| prime-agent 式平台吸收进化能力 | 同步做头部 harness 扩展点接入（如 `session_before_refine`），变对手为渠道 |
| 领域热度周期短（训练侧一代集体停更为证） | 本地优先、低运行成本形态天然抗周期 |
| 策略性文档公开的措辞风险 | 本文只陈述事实性格局与定位，不含内部战术时间表 |

## 7. 立项前待答问题（留给未来 kickoff）

1. 引擎抽包边界：现有 `src/*` 中哪些随 cordis 插件壳留在原仓，哪些进新引擎包？
2. 通用轨迹格式（adapter 协议）的最小字段集与版本化策略？
3. daemon 进程模型：常驻服务 vs 按需 CLI 触发？审批队列的通知通道？
4. 新仓 vs monorepo；命名与 npm 组织归属？
5. 与 dsh-continual-evolve 插件的关系收束：插件降级为 DSH adapter，还是双轨并存？
