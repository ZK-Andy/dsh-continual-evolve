# 产品形态探索报告：从「对话内进化」到「自进化开发框架」

> 2026-08-24 探索会话产物，竞品数据截至当日。北极星定位：**自进化开发框架**（双循环架构见 §5，载体决策依据见 §8）。方向已采纳（用户拍板），**未立项**——实现计划、ADR 与代码变更均未启动。配套背景：[design.md](../design.md)（引擎设计）、[gap-analysis.md](../gap-analysis.md)（2026-08-17 差距分级）。

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

## 5. 定位决策：「自进化开发框架」（已采纳）

> 静态开发方法论（spec-kit/BMAD 类）负责把 AI 协作纪律分发下去；本框架让方法论在真实使用中自己变好——且每一次变好都经 benchmark 门禁验证、版本化发布、可审计可回滚。

**双循环架构**（产品灵魂）：

```
内环（每个采用项目）：装模板 → 按流程卡开发 → 门禁强制 → HANDOFF 交接
                                  ↓ 产生
                        真实开发轨迹（坑位/返工/违规）
                                  ↓ 回流
外环（框架自身）：ingest 轨迹 → distill 坑位→卡片/门禁修订提案
              → benchmark 门禁验证 → 审批队列 → 版本化发布 → 采用者升级
```

- **内环** ＝ 方法论骨架（devops-template）＋ 流程知识层（七张流程卡）——静态可用，今天已在三个项目跑通（C# 与 TS 两套技术栈）
- **外环** ＝ 自进化引擎的产品化——静态方法论产品没有的一环，也是「自进化」的全部含义

**三支柱（外环治理内核，「进化的信任层」能力原样复用）**：
1. 框架资产统一版本库 + 细粒度回滚——卡片/门禁/规则的每次演进可审计
2. benchmark 门禁决定接受/拒绝——新卡新规先在 eval 集上证明自己（两段式评估、rubric ACL、失败格协议均为存量能力；卡片遵循度是天然的行为型 benchmark case）
3. 全链路审计 + 轨迹重演

**产品形态**：方法论骨架（模板仓，分发单元）＋ 本地优先常驻引擎（ingest→distill→review→apply→measure 异步流水线，以 CLI/MCP 形态服务任何 agent 环境）＋ Web 控制台（条目库 / refinement 版本 diff+label 回滚 / scoreboard 实验 / 审批队列 / 度量面板 / 设置 六段式导航）＋ 框架版本化发布与升级通道。

**输入源**：适配器架构——定义通用轨迹格式；采用者的 agent 环境即轨迹源（Claude Code/Codex/Cursor/opencode 各有 adapter 空间，适配手册已覆盖），DSH 会话存储是第一个参考实现。

**包装原则**：方法论与提炼内容 MIT/Apache（保留 deepseek-harness 出处声明）；原创增量（流程卡/治理脚本/引擎）构成品牌边界；本地优先无强制云账号；永不收回 self-host 承诺。

**对两类对手的差异**：对静态方法论产品——它们不观察自己的使用、不改写自己；对 self-evolving agent builder（penguin 等）——它们进化 agent 本体，既不做开发方法论层，也没有治理内核。

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
4. 命名与 npm 组织归属（载体已定为独立新仓，见 §8）。
5. 与 dsh-continual-evolve 插件的长终局关系（短期已定：插件保持现状不动，见 §8）。
6. 静态方法论竞品快扫（GitHub spec-kit / BMAD-method / Agent-OS 等）：验证"自适应方法论无人做"的判断，并研究其安装器/升级机制可借鉴处。
7. 外环冷启动：如何从三个项目的存量轨迹（sessions 99MB + FAQ/卡片演化史）离线跑出第一个可见进化案例。

## 8. 载体决策记录：为什么是开发框架而不是抽象控制平面

同日探索曾先产出「进化的信任层」定位（面向任何 agent 的自进化治理控制平面）；经用户澄清真实意图——把三个项目共用的开发模板与流程卡本身做成产品、与自进化结合——定位收敛为「自进化开发框架」，信任层三支柱降为外环治理内核。

**资产实底**：

| 项目 | 在框架中的角色 | 关键资产 |
|---|---|---|
| devops-template | 方法论骨架（分发单元） | AGENTS.md 分层规则、九层文档分类法、ADR 系统、11 技能（MIT 提炼）、零依赖门禁脚本、多 agent 适配手册（opencode/Claude Code/Codex/Cursor） |
| dotnet-deepseek-harness-desktop | 第一验证场（C# 栈） | 模板首次落地 + 七张流程卡原型 |
| dsh-continual-evolve | 流程知识层 + 进化内核 | 流程卡七张 + verify-governance + hooks 接线 + 自进化引擎（543 测试） |

**选择理由**：

1. **载体已经实战验证**：两套技术栈（C#/TS）的真实开发打磨；卡片坑位全部来自真实故障（npm EROFS、deps-status sqlite、gh graphql 双重转义等）
2. **获客路径内建**：「装模板」的心智已被静态方法论产品教育；每个采用仓库即一个部署点，无需单独说服用户安装 daemon
3. **进化效果第一次可度量**：坑位复发率、门禁拦截率/误报率、卡片遵循度皆为硬指标，优于「懂你度」类主观信号
4. **外环已有手工原型（Case #0）**：dotnet→本仓的卡片迁移顺手修复上游 verify-governance 缺陷并反哺 dotnet 仓（`8cd61d0`）；release-flow 卡将发版坑位入卡——今天人肉完成的外环进化就是产品要自动化的东西

**诚实难点**：

1. 引擎脱壳（cordis 插件形态 → CLI/MCP 通用形态）是工程量主体
2. 外环冷启动初期只有自有项目供血——存量轨迹可离线 bootstrap 出首个可见案例
3. 静态方法论竞品边界未扫描（§7 第 6 问）
4. 品牌边界：MIT 提炼内容与原创增量的划界需在产品化时明确

### 8.1 载体落点决策（已定）：独立新仓

| 方案 | 结论 |
|---|---|
| 在 dsh-continual-evolve 上做加法 | 否决——包名与 `@deepseek-ai/dsh-*` peerDeps 锁死 DSH 插件身份，而框架受众是全体 agent 用户；发布节奏与 DSH rc 兼容周期耦合；「框架拥有内核→插件变消费方」的依赖反转永远做不了 |
| devops-template 原地产品化 | 不单独采用——其内容作为种子并入新仓（该目录无 git 历史，迁移零成本） |
| **独立新仓（采纳）** | monorepo；用自家模板+流程卡开张（dogfooding 即首个案例），旧仓保持 DSH 插件现状 |

**分阶段计划**：

- **Phase 0（静态内环，零引擎代码）**：`template/` 方法论骨架 + `cards/` 七张流程卡（含多 agent 适配手册）+ 最小安装器——现有内容即可发 v0.1，先验证市场对「AI 协作开发纪律」的需求
- **Phase 1（外环 MVP）**：从本仓抽取零 DSH 耦合的纯 TS 核心（state/apply/service/store/validate/rollback/score/evaluate/search 及配套测试），以 CLI/MCP 形态成为框架外环内核
- **本仓定位不变**：继续作 DSH 插件维护与引擎研发场（#15 R1–R3 实机验收照常）；README 加一行导流；待 Phase 1 内核发包后，再议插件是否改为依赖新包

**判据速记**：身份/受众纯净、发布节奏解耦、依赖方向可达、治理资产复用（新仓直接吃自家狗粮）、本仓稳定性不受扰动、迁移成本近零（devops-template 无历史包袱）。代价：双仓维护（流程卡本为多项目设计，可控）、Phase 1 测试搬迁工作量、社区信号短期分裂（早期以新仓为主战场）。

### 8.2 DSH 适配决策（已定）：三级阶梯，早期零插件

框架对 DSH 的适配**不走插件**——DSH 原生的文件自动发现机制已构成零代码适配面，且已在本仓与 dotnet 仓验证运行：

| DSH 原生机制 | 框架对应物 |
|---|---|
| cwd 进入项目目录自动加载根 `AGENTS.md` + `.agents/AGENTS.md` | 开发规范与流程卡索引载体 |
| `.agents/skills/` 自动发现 | 流程性技能分发（纯 markdown） |
| git `core.hooksPath` + Python 门禁脚本 | 机械强制层（与 agent 无关） |
| CI 文档门禁步 / governance.yml / PR·Issue 模板 | 异地强制兜底 |

**三级阶梯**：

- **L0 约定适配（Phase 0 即用）**：上述文件布局约定——复制即用、零版本耦合
- **L1 技能化增强（Phase 0 后期可选）**：session-open/close、handoff 等流程卡打包为 `.agents/skills/`——skill 目录摘要随会话开场自动注入，触发可靠性高于「AGENTS.md 一句话指向卡片」；仍零代码
- **L2 插件伴生（自进化阶段才启用）**：外环需要命令面/提示词注入/事件监听时才上 cordis 插件；形态即 dsh-continual-evolve 内核的演进，作为框架可选伴生件推荐安装

**插件不适合框架本体的理由**：① 静态内环用不上命令/注入/事件三样插件能力；② 插件形态背上 DSH rc 版本兼容税；③ 「DSH 进化插件」生态位已被 dsh-continual-evolve 占据；④ 对非 DSH 用户形成 npm+cordis 采用门槛。

**连带发现（安装器必备组件）**：七张流程卡目前在 dotnet 仓与本仓是两份拷贝，已在漂移轨道上（本仓 release-flow 已含 npm 发版坑位重写）。模板类产品的核心问题是**采用者如何拿到更新**——安装器从第一天起须带升级通道：卡片单一事实源在框架仓并带版本号，升级走 diff 式覆盖＋本地适配保护标记（先例：本仓 verify-md-links 的「勿用模板版覆盖」适配）。

**冷启动产品矩阵**：框架新仓（产品本体：方法论+流程卡+安装器，L0/L1 适配 DSH）；dotnet-deepseek-harness-desktop（参考采用者 #1，C# 栈公开仓）；dsh-continual-evolve（参考采用者 #2，TS 栈＋未来 L2 伴生插件的内核供体）。叙事：「诞生于两个真实开源项目的 AI 协作开发，跨双技术栈验证」。
