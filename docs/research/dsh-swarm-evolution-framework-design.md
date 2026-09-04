# DSH 蜂群进化框架 · 设计文档

> 日期：2026-09-04
> 状态：**设计（proposed）** · 落档于 `docs/research/`（设计草案，未立项）
> 定位：**推倒重建级**（不沿用旧体系决策），以 EvoMap / EvoX / JIT-Agent / superpowers / OmO 为参考，**去伪存真、取其精华**，建立在 **DeepSeek Harness 插件基建**之上。与 `dsh-collective-evolution-shared-layer.md`（此前共享层设计，`21fc6c5`）方向一致但**重构**，本设计为新的基准；两者关系见 §13。
> 范围：完整框架设计。不含实现。DSH 插入点位基于真实源码核准（见 §11）。
> 更新（2026-09-04）：确立 **AGI 为终极北极星**（方向，非当前范围）；确认 **DSH 的"时间×空间可组合性"**（Everything is a plugin + Every run is traceable）为承载；确立 **胶囊 = DSH 插件/skill、胶囊组合 = DSH 预设、进化 = 演化这些模块**。

---

## 0. 一句话定位

**做一个建立在 DeepSeek Harness 插件架构之上的"蜂群进化框架"：让"AI 协作编码方法论"成为第一个可被蜂群共同演化、且每次演化都经机器可复现验证、绝不跑偏也不变臃肿的进化胶囊。终极北极星是 AGI——本框架是通往它的若干条真腿之一，但当前聚焦"AI 协作编码"这一具体领域，AGI 只定方向、不定当前范围。**

---

## 1. 理念与北极星

### 1.1 我们真正感兴趣的东西

不是"再做一个 agent"，也不是"再做一个方法论包"。是**蜂群进化**——让一群人 / 一群 agent 在**真实项目**里共同演化同一套 AI 协作方法论。单个 agent 演化太慢、覆盖的项目类型太窄；蜂群演化才能**快速迭代、快速验证覆盖**。

### 1.2 北极星

「**自进化开发框架**」——一个会自己变好、且每次变好都被验证、可被群体共同演化的 AI 协作编码框架。它即是方法论本身，也是自我演化这套方法论的沙盘（self-hosting）。

**终极北极星（AGI）**：长期来看，我们做的是"智能系统自我改进的原始积木"——自我连续性（跨会话不遗忘）、终身学习（演化/蒸馏）、可验证性（机器校验/审计）、元认知（右方向校验即自反）、世界模型（方法论的结构化）。这些都是 AGI 的真实子问题，本框架是通往它们的若干条腿。**但 AGI 只定方向，不定当前范围**：不因"终极目标=AGI"而膨胀成宏大理论框架（那会重蹈"沉掉的东西没收益、只烧 token"的覆辙）；落地仍从第一个胶囊（AI 协作编码方法论）扎实做起。

### 1.3 价值锚点

提高**AI 协作编程能力**。差异化卡位 = **中文工程治理纪律 × 最小可信机械门禁 × as-needed 知识加载 × 克制性进化**。正面进攻通用方法论（如 superpowers 的英文通用技能包）必败；我们赢在"工程治理 + 机器门禁 + 决策进化"这个它们都没覆盖的交集。

---

## 2. 为什么必须建立在 DeepSeek Harness（关键核心）

**这是整套设计的前提，也是"没有 DSH 我们完全无法做到"的原因。**

### 2.1 命题

DSH 是**全插件化**的 agent，且**所有插入点位完全开放**。我们可以**任意的在所有插入点位按我们的需求侵入**，完成一个节点的**彻底控制**、按我们的需求运行。这意味着我们不是在"外部凑一套工具再夹带入 agent"——而是**成为 DSH 运行本身的一部分**，在它收拢 agent 生命周期的每一个关节上，落我们自己的逻辑。

### 2.2 没有 DSH 的替代者为何都不行

- **superpowers / OmO / spec-kit**：静态方法论包，只能在"文档层"分发，无法侵入 agent 运行，无法做"运行时演化 / 机器门禁 / 决策版本化"。它们没有宿主级插入点位。
- **EvoMap / JIT**：自带引擎，但要处理"如何接入任意宿主、如何把演化产物注入运行时"——它们各自建了自己的宿主/协议，代价是重或封闭（EvoMap GPL→source-available、JIT 需 27B 元模型）。在 DSH 上，这些注入点位**已经存在且开放**。
- **自制独立引擎**：等于重造一个 agent 宿主，工程量重复，且失去 DSH 带来的 agent 生态（subagent / goals / workflow / hooks / 插件市场 / capability manifest）。

**结论**：DSH 是唯一**原生提供全套可侵入插入点位**的宿主；我们的"节点级彻底控制"只有在一个全开放插入点位的 agent 宿主上才能成立。

### 2.3 时间×空间可组合性（DSH 官方表述，关键的承载）

DSH 的官方设计哲学（[Everything is a plugin](https://www.deepseek.com/harness/en/)，另有 [Cordis 论文](https://arxiv.org/abs/2608.25512)）是两大条，恰好构成"时间×空间"两个维度：

| 维度 | DSH 官方表述 | 对我们意味着 |
|---|---|---|
| **空间（一切皆插件）** | "Every capability is a plugin that can be swapped or recomposed: models, tools, skills, sessions, sandboxes, storage, loops, scheduling, the UI." | 每个能力（模型/工具/技能/会话/沙箱/存储/循环/调度/UI）都是**可替换、可重组**的插件 → 我们的"胶囊"就是 DSH 插件/skill 单元 |
| **时间（每次运行可追溯）** | "Everything the model sees is recorded in an append-only session log… Resume, fork, search, and replay all operate on the same event stream." | agent 的每一次运行都记成 **append-only、可回放、可分叉的事件流** → 经验是"可组合的时间线"，不是丢掉的过去 |

**DSH 已内置的"组合成预设"机制**：
> **Creator mode**："combine them into new modes"——检查当前运行时、在内存里试验 Cordis 插件、**把它们组合成新的模式（preset）**。官网还直接给出 Standard / Code / Minimal / Creator 四种现成 preset（profile/bundle 叠加，见 §11）。

**这如何钉死我们的设计**：
- **我们的"胶囊技能" = DSH 的插件/skill 包**（模块化、可替换、可重组）
- **"每套胶囊组合 = 一个完整 DSH 预设" = DSH 的 profile/preset**（正是 Creator mode："combine them into new modes"）
- **蜂群进化 = 演化这些胶囊模块**（一个胶囊 = 一个可被校验、可版本化、可共享的插件单元）

**时间维度是 AGI 的命门**：DSH 把经验记成可重放、可分叉的事件流——这正是（a）自我连续性（跨会话的"我"不遗忘）、（b）学习/演化的原料（回放轨迹→提取 gene）、（c）可回溯可审计（"是否真改进"有据可查）的前提。我们要做的，是把这条时间线**升维成可被蜂群共同演化**。

---

## 3. 参考框架去伪存真

> 原则：**取其精华，去其糟粕，融会贯通**。不因一家踩坑就一棍子打死；坏的是某一层，不是全部。

### 3.1 逐家提取

| 框架 | ✅ 精华（取） | ❌ 糟粕（弃） |
|---|---|---|
| **EvoMap/evolver** | Gene/Capsule/Event + memory-graph 演化原语；content-addressable、append-only、可审计；Gene 紧凑策略 > 长 Skill 文档（4590 次实验证明）；信号驱动生命周期；因果记忆图驱动选择（优选/禁用/衰减/ban）；验证命令白名单；`.gepx` 可移植归档；skill distillation 元演化；离线优先 | Hub 层：积分经济奖励"发布"而非"被采用"、验证靠自报日志、GDI 被刷分、GPL/source-available 封闭、中心 hub 依赖 |
| **EvoX** | 演化本身是基础设施/运行时；**元演化**（AutoPSO：把参数+学习+蜂群结构编入可搜索空间，演化策略本身）；**蜂群观测透镜**（agent matrix：看到经验在传播/分歧/被拒）；长程递归演化 + token 高效（$44 建 25 万行编译器）；观测信号驱动演化决策 | GPU 重型演化计算（与"方法论"体量不匹配）；其蜂群是"任务计算蜂群"，非"方法论进化蜂群" |
| **JIT-Agent** | 六根护栏（协议约束生成 / 沙箱执行验证 / 有界修复 / **只修异常不修低分** / **保守入档-前沿单调不降** / **答案盲选择**）；**Model-as-a-Harness 的 just-in-time 现场合成**（= 正确懒加载的活例）；"收益 ∝ 反馈结构化程度"规律 | 部署期无金标就缺奖励燃料；逐任务生成贵（27B 元模型）；主表数字不可复现、发布 checkpoint 与论文不一致（可信度教训） |
| **superpowers** | 一行安装 + 自动触发技能包；单仓多 manifest（覆盖 14 harness）；可组合技能——"方法论即技能包"的分发/易用范式被市场验证到 GitHub 顶级 | 份量太重；英文通用流程；靠模型**自觉**触发；无机械门禁/无审计/无自进化 |
| **OmO / spec-kit** | 流程有纪律；Spec 驱动有条理 | 流程复杂；机械门禁**可逃逸** |
| **GEPA** | 遗传 + 自然语言反思；**多目标 Pareto 支配**（防单维刷分） | 偏文本参数优化，需定义评估指标 |
| **AIDE²** | 树搜索 actor + 执行反馈；eval reviewer 读执行输出；递归自改进 | 需大量执行成本 |

### 3.2 融会贯通（精华互相补缺）

- EvoMap 给了**正确的演化原语**，但它的信任/分发层烂了 → **JIT 六根护栏**补上这层（机器可复现执行校验 + 单调前沿海，替代"自报/积分"）。
- JIT 护栏需要"被演化对象 + 可观测群体" → **superpowers 的技能包分发范式** + **EvoX 观测透镜**补上（升维成"可分发、可观测的群体演化"）。
- superpowers 有易用性和分发，无自进化 → **EvoMap 引擎 + JIT 护栏**给它装上"会自己变好、且变好可验证"的外环。
- EvoX 有元演化 + 观测，缺轻量可校验的原子 → 我们的 **Gene/胶囊**（一条规则 / 一张流程卡 / 一个踩坑）就是那个原子。

**真正算"我们自己的"**：把"AI 协作编码方法论"本身当作被演化的**胶囊**（无人做过），加上 **中文工程治理纪律 × 最小可信机械门禁 × as-needed 知识加载 × 克制性进化——每次进化都是真进步且不变臃肿**。

---

## 4. 核心命题：第一个杀手级进化胶囊

**第一个进化胶囊 = AI 协作编码框架**（covering 项目全生命周期）。它是"杀手级"的，因为：

1. 它覆盖最多人真正需要的场景（谁写代码都需要 AI 协作方法论）。
2. 它落在"**收益 ∝ 反馈结构化程度**"的最高档（JIT §7：确定性门禁领域演化收益最大）——框架自身的规则/门禁/流程卡**全部可用确定性脚本校验**（ADR 格式 / 字数预算 / md-links / typecheck / lint / test / governance），所以演化能精确吃到"差在哪"，收敛可预期。
3. 它是**自我宿主**的 sandbox：用这套方法论写这套方法论本身。

**并且它天然是 DSH 可组合单元**（见 §2.3）：**每个胶囊 = 一个 DSH 插件/skill 包；一整套胶囊组合 = 一个完整的 DSH 预设（profile/mode）**——同一套方法论按任务类型组合成不同预设（初始化预设 / 文档治理预设 / 踩坑预设 / 规范预设 / benchmark 预设…），让 DSH 变成一个任务特定的协作体。

### 4.1 胶囊的内容域（项目全生命周期）

- 怎么初始化一个项目
- 项目开始后如何选择开发流程
- 开发中文档怎么管理
- 踩坑记录怎么做
- 代码规范如何调整
- 架构规范如何调整
- 代码如何优雅高效地实现
- …（AI 协作编码框架的方方面面）

### 4.2 双态定位（对谁产生价值）

胶囊资产有两种形态，共享同一原子内容，**且都以 DSH 插件/skill 包的形式落地**：

| 形态 | 消费者 | 内容形态 | 触发方式 | DSH 载体 |
|---|---|---|---|---|
| **低层控制信号（gene）** | agent | 紧凑、行为导向、失败感知（含 AVOID） | session/工具边界，按需注入 | DSH skill/`system-prompt` 节注入 |
| **高层方法论资产（胶囊）** | 人/团队 | 流程卡、门禁脚本、踩坑记录、规则 | 文档/技能包，按需检索 | DSH skill 包 / `cordis` 插件 |

两者映射同一原子：**一条方法论规则**，机器侧可校验、人侧可读；同一条即一个 DSH 可组合单元，按任务组合成不同预设（§4 开头）。

---

## 5. 架构分层

```
 DSH 蜂群进化框架
 ┌──────────────────────────────────────────────────────────┐
 │ ① 演化引擎（每 agent/项目一份）                            │
 │    Detect→Select→Mutate→Execute→Evaluate→Solidify        │
 │    Gene / Capsule / Event / memory-graph 原语             │
 ├──────────────────────────────────────────────────────────┤
 │ ② 验证与右方向闸（分水岭，非 EvoMap 式自报）               │
 │    机器可复现执行验证（CI 式）+ 安全白名单                 │
 │    token 基线不变量（dsh-token-meter）控制"别变臃肿"         │
 │    dsh-invariants 机械不变量                               │
 ├──────────────────────────────────────────────────────────┤
 │ ③ 知识懒加载（as-needed，DSH system-prompt order 节）       │
 │    常驻基座（极少、高度凝练）                              │
 │    + 情境按需（按相关性检索、注入成控制信号）                │
 ├──────────────────────────────────────────────────────────┤
 │ ④ 集体/共享层（蜂群）                                      │
 │    git 基因库 + CI 验证闸（$0，替代中心 Hub）                │
 │    观测透镜（哪些 gene 传播/分歧/被拒）                     │
 │    奖励被采用，不奖励发布                                  │
 ├──────────────────────────────────────────────────────────┤
 │ ⑤ 元演化/自组织                                            │
 │    蒸馏（失败压缩成 gene）/ 组合（capsule）                 │
 │    元演化（演化策略自身可搜索）+ 长程递归演化                │
 │    蜂群自组织 + 克制性方向控制                              │
 └──────────────────────────────────────────────────────────┘
```

### 5.1 核心原语（对齐 GEP，但自定 DSH 私有协议，MIT 干净）

| 原语 | 角色 | 关键字段 |
|---|---|---|
| **Gene** | 可复用的演化策略（控制信号） | `signals_match`（触发）、`strategy`（有序步骤）、`constraints`（max_files/forbidden_paths）、`validation`（真执行命令）、`AVOID`（失败面压缩成警告）、`summary` |
| **Capsule** | 一次真实执行的审计记录 | `gene`、`trigger`、`diff`/`content`、`outcome`（status/score）、`blast_radius`、`confidence`、（可选）cost_tokens/cost_usd |
| **Event** | 不可变演化日志 | `intent`、`signals`、`genes_used`、`mutation_id`、`outcome`、`capsule_id`、`env_fingerprint`、`validation_report_id` |
| **Mutation** | 意图声明 + 风险 | `category`、`target`、`expected_effect`、`risk_level`（low/medium/high） |
| **memory-graph** | 因果链（signal,gene)→outcome | 驱动选择：优选/禁用、置信衰减（半衰期）、ban 阈值、路径抑制 |

**设计原则**（来自 §3 + 安全哲学）：紧凑、行为导向、失败感知、机器可校验边界、content-addressable（SHA-256 防篡改）、append-only、先本地验证才进共享管线、可选离线。

**原语 ↔ DSH 载体**（§2.3/§4.2）：`gene`/`capsule` 的**可控内容**（策略+约束+AVOID）落地为 DSH **skill 包**（可组合、可注入）；`Event`/`memory-graph` 的**审计与因果**落地为 DSH **append-only 会话日志** + 插件存储（`dsh-storage`/`dsh-atomic-write`）；区块**组合成 preset** 对应 DSH 的 **profile/mode**。

---

## 6. 演化生命周期（映射到 DSH 插入点位）

| 阶段 | 内容 | DSH 插入点位 |
|---|---|---|
| Detect | 扫描运行上下文找信号（错误/机会/控制信号） | `session/event`、`agent/error`、`agent/turn-stopping`、`tool/result` |
| Select | 按 `signals_match` + memory-graph + 观测透镜选 gene | 纯逻辑（插件内部） |
| Mutate | 构造 Mutation（意图 + 风险） | 纯逻辑（插件内部） |
| Hypothesize | 记录"给定信号+gene+mutation→预期结果" | 纯逻辑（写 memory-graph） |
| Execute | 按基因约束产出改动 | `agent/request`、`tool/call`、`subagent/*` |
| Evaluate | blast-radius + 约束检查 + **真执行验证命令** + 评分 | `command/run`、`tool/result`、`agent/status` |
| Solidify | 写 Event、成功则造 Capsule（diff+strategy+内容）、应用 env 标记、触发蒸馏、入档 | `session/flush`、`agent/disposed` |

**关键纪律**（贯通 §3.2 护栏）：
- **只在"无金标"下用代理信号选择**（logprob / 独立 judge / 观测），**绝不用 ground-truth**（答案盲选择）。
- **只修异常、不修低分**：门禁失败才重试；绝不为弱评分者/自报分过拟合。
- **保守入档**：只有"严格改进且无回归（奖励/延迟/成本 任一维真改进）"才进资产库；否则档案不变 → **前沿单调不降**，更差的永不污染归档。
- **多目标/门控**：效率通道以"成绩不缩水"门控（防牺牲准确率换低延迟），奖励主通道 ≥ 基线才计（防单维刷分）。

---

## 7. 机械校验与"往正确方向进化"保证（最小可信集）

> **没有人能形式化保证"往正确方向进化"**。EvoMap/JIT/GEPA 全都是用"保守工程护栏"把系统偏向不回归。真正的差距在护栏**硬不硬、可不可真执行**。我们把它收窄成**最小可信集**（克制、不堆门禁，但每一条都真能拦住坏演化）。

### 7.1 我们的最小可信护栏（6 条）

1. **协议约束生产**：被演化物（gene/流程卡/规则）必须满足可校验的结构接口——可验证性从源头建立。（JIT 四模块、GEP schema）
2. **机器可复现执行验证**：候选必须**真实跑起来**通过确定性检查（lint/typecheck/test/ADR 格式/字数预算/md-links/governance），**不是自报日志、不是空洞测试**。（JIT 沙箱、Behind EvoMap 教训）
3. **只修异常、不修低分**：门禁失败才重试；绝不为弱评分者/自报分过拟合。（JIT）
4. **保守入档 / 前沿单调不降**：只有"严格改进且无回归"才进库。（JIT、EvoMap 本地引擎）
5. **答案盲选择**：候选比较绝不用金标，用 logprob/judge/独立执行；防泄漏。（JIT）
6. **多目标 + 奖励门控 + token 基线不变量**：防单维刷分；**任何演化不得抬高常驻 token 基线**（用 `dsh-token-meter` 度量），否则视为回归拒绝。（GEPA、JIT、我们的"别变臃肿"）

### 7.2 具体机制

| 你要的机制 | 实现方式 |
|---|---|
| **测试标准 / 测试用例** | 每一个被演化的资产（规则/流程卡/门禁）有**自带的验证命令**（`validation`），即它的"测试用例"。标准化为：确定性校验（lint/typecheck/test/格式门禁）+ 行为级回归用例 |
| **检查 token 消耗基线** | 用 `dsh-token-meter` 的 `estimateContent` / `contextBreakdown` / `contextPressure` 度量**常驻注入基线**（system-prompt 节 + 目录注入）。**不变量**：新增知识若抬高常驻基线 → 该演化"无效"（须转为 as-needed 懒加载可检索、不进常驻） |
| **用户启动子代理自动跑** | 演化候选进入验证闸时，由宿主**子代理在新鲜沙箱自动执行**验证命令集（`subagent/*`），真执行非自报；执行者与评审者分离（防自产自审） |
| **发起合并时带自校验结果** | 合并（PR/consolidate）时**必须携带机器已验证的证据**：验证命令结果、测试通过数、token 基线 diff、benchmark 结果。合并闸由 CI 复跑同一验证（跨机器可复现），绿了才合入 |

### 7.3 为什么这套在 DSH 上成立

- **`dsh-token-meter`** 原生提供 token 度量源 → "token 基线"不是估算而是可测。
- **`dsh-invariants`** 原生提供机械不变量 → "别变臃肿 / 别违反契约"可机器强制。
- **`subagent/*`** 原生提供子代理执行/委托 seam → "子代理自动跑"不是自建。
- **`command/run` + `tool/result`** 提供命令与工具结果钩子 → "合并/演化边界"可注入自校验。
- **system-prompt 有序节（`order`）** 提供"空则零 token"注入 → "as-needed 懒加载"是宿主级能力。

---

## 8. 知识懒加载模型（as-needed）

> 你最初的痛点：知识散文件 + 整读烧 token + ADR 零散难维护。这一层直接解决。

### 8.1 两层知识

| 层 | 内容 | 加载策略 | token 成本 |
|---|---|---|---|
| **常驻基座** | 极少、高度凝练的"元规则"（当前模式/质量门命令/核心纪律，如 800 词级 AGENTS） | 每次会话常驻、封顶 | 固定且**极小** |
| **情境知识** | ADR/踩坑/流程卡/规范/FAQ——每条一个可检索原子 | **as-needed**：按当前任务相关性检索，命中才注入成控制信号 | **按需**，摸不到零成本 |

### 8.2 一条知识 = 一个原子胶囊

- 旧的：ADR 写成零散 md 文件、FAQ 写成整篇、踩坑散在 HANDOFF——**散 + 难维护 + 每次整读**。
- 新的：每条（决策/踩坑/规则/流程）是**一个 content-addressable capsule**，带（领域标签、症状、根因、规避法/AVOID、来源、版本）。机器可校验、人可读、可检索、可回滚、**可进化**。
- 这同时满足三件事：**单源**（不再三处漂移）、**懒加载**（不整读）、**可进化**（能被蜂群共同迭代）。

### 8.3 DSH 注入点

- 常驻基座：system-prompt 节（`order` 固定），渲染为空则零 token。
- 情境知识：按相关性检索出的 gene 经 `agent/session-start` / `agent/pre-step` / 工具边界注入成控制信号（短、带 AVOID，不是长文档）。
- 全量目录视图封顶（一行式 `[kind:id] title` 索引），避免污染每轮构建。

---

## 9. 集体/共享层（蜂群）

> 决策：**git 基因库 + CI 验证闸**（$0、免费、天然带版本/审计/回滚/分发/检索）。替代 EvoMap 中心 Hub。

### 9.1 形态

```
 dsh-gene-bank（免费 GitHub 公共仓库）
 ├─ genes/<domain>/<gene-id>.gene.yaml
 ├─ capsules/<domain>/<capsule-id>.capsule.yaml
 ├─ manifest.json          # 检索索引：domain/tag → 基因指针
 └─ .github/workflows/validate.yml   # 每 PR 重跑真验证（机器闸）
```

**角色**：git 仓库 = 免费"券商/市场"；PR + CI = 仲裁；维护者 = 合入执行者。**没有积分、没有自报打分。**

### 9.2 消费（pull → 注入）

1. `git pull`（或 shallow fetch + sparse checkout 目标 domain）到本地缓存。
2. 读 `manifest.json` → 按 domain/keyword 选 top-N 相关基因。
3. 在 session 开始 / 工具边界把基因作控制信号注入（短、带 AVOID）。

### 9.3 贡献（push = 真验证过才 PR）

1. 本地演化产出候选基因 → **先本地跑基准/verify**。
2. 通过 → staging 基因 + 验证证据（`evidence_ref` 指向可复现 CI run）→ **开 PR**。
3. 仓库 CI **跨机器重跑同一套验证** → 绿了才被维护者合入。**验证是机器执行，不是自报。**
4. 合入后全网 agent 下次 pull 即得。

### 9.4 蜂群观测（EvoX 精华，但只作观测不作积分）

- 观测哪些 gene 被采用/被拒/传播/分歧，作为演化信号与多样性守卫（防 EvoMap 单文化）。
- **奖励被采用，非发布**；观测数据不转为可刷分的排名。

---

## 10. 第一个胶囊：AI 协作编码框架（内容域细分）

>>> 说明：这部分是"被演化的内容"，不是框架本体。它既是我们自己用的方法论，也是蜂群要共同演化的对象。 <<<

| 域 | 内容 | 对应机制/门禁样例 |
|---|---|---|
| 项目初始化 | 模板、依赖、目录结构、CI 骨架、插件接线 | 初始化脚本、`verify-*`、一键安装 |
| 开发流程选择 | 讨论/调研/实现/发布模式契约 | session-modes 卡、feature-flow 卡 |
| 文档管理 | ADR/FAQ/设计/踩坑/交接 | 一条一胶囊、懒加载、单源不漂移 |
| 踩坑记录 | 每坑一原子胶囊（症状/根因/规避/来源） | 检索注入、AVOID 警告、回归用例 |
| 代码规范 | 编码约定、评审清单 | 可 lint/typecheck机械校验 |
| 架构规范 | 分层约束、blast-radius、依赖边界 | 机械校验（scope/blast-radius）+ ADR 决策 |
| 优雅高效实现 | 性能优先、复杂度评估、失败感知 | 测试门禁、benchmark 门禁 |

---

## 11. DSH 插入点位清单（真实核准）

> 全部为真实源码核准的 cordis 生命周期钩子 / 服务扩展名。

### 11.1 生命周期钩子（可 `ctx.on/before/after`）

| 分类 | 钩子 | 用途 |
|---|---|---|
| Agent | `agent/session-start` `agent/status` `agent/turn-stopping` `agent/pre-step` `agent/request` `agent/request-error` `agent/error` `agent/disposed` | 会话开始注入基因；回合边界触发演化判断；失败信号检测 |
| Session | `session/created` `session/event` `session/flush` `session/end-seed` `session/title` `session/disposed` | 轨迹信号、压缩边界、固化落盘 |
| Turn | `turn/start` `turn/end` | 回合成本/边界钩子 |
| Tool | `tool/call` `tool/result` `tool/code-dispatch` `tool/code-dispatch-start` | 工具结果信号、代码分发边界注入 |
| Command | `command/run` `command/done` | `/evolve` 类命令面、合并/验证注入 |
| Approval | `approval/asked` `approval/decided` `approval/policy` | 人工审批（全局写需用户批准） |
| Goal | `goal/change` | goal 驱动轮次（active goal 时每轮触发） |
| Subagent | `subagent/descriptor` `subagent/model-selection-policy` | 委派 spec 注入、子代理执行（真执行验证/独立评审） |

### 11.2 服务扩展面

| 扩展面 | 机制 | 用途 |
|---|---|---|
| System-prompt | **有序动态节（`order: number`）**，空则零 token | 常驻基座 + as-needed 基因注入 |
| 工具 | `defineTool` | 暴露演化/检索/校验工具（`evolve_list`/`evolve_add`... / `gep_recall` 式） |
| 命令 | `CommandInvocation`/`CommandResult` | `/evolve` 命令面（list/consolidate/wrapup/verify/benchmark...） |
| 子代理 | `ctx.subagents`、`ctx.get("goals")` | 委派、跨插件服务访问 |
| Token | **`dsh-token-meter`**（`estimateContent`/`contextBreakdown`/`contextPressure`） | **token 基线度量源** |
| 不变量 | **`dsh-invariants`**（check/violation） | 机械不变量（别变臃肿/别违反契约） |
| 插件 | plugin inventory / capability manifest / marketplace | 分发与权限隔离适配层 |
| **插件组合/预设** | **"一切皆插件"**：profile = 按序叠加的 plugin-bundle patch 层（`dsh.profile.bundles` + `cordis.patch.yml`，从空根组合）；**Creator mode** 把插件组合成新 preset（Standard/Code/Minimal/Creator 四种现成 preset）。[Cordis 论文](https://arxiv.org/abs/2608.25512) | **胶囊组合成 DSH 预设**（§2.3/§4）：一整套胶囊 = 一个任务特定的 profile/mode |

---

## 12. 路线图（分阶段）

1. **P0（本设计）**：定 Gene/Capsule/Event Schema + 最小可信护栏清单；把既有方法论资产（AGENTS/ADR/流程卡/verify）协议化成首批基因。
2. **P1 局部闭环**：演化引擎（Detect→…→Solidify）+ 验证闸 + as-needed 懒加载，完全本地/离线可用；token 基线不变量落地（用 dsh-token-meter）。
3. **P2 集体共享**：git 基因库 + CI 验证闸；跑通"贡献→CI→合入→pull 复用"闭环。观测透镜。
4. **P3 元演化**：蒸馏（失败→gene）/ 组合（capsule）/ 策略自身可搜索 / 长程递归演化。
5. **P4 发布**：一行安装、插件市场分发、多 harness 适配（借 superpowers 分发范式）。

---

## 13. 风险与未决问题

**风险**
- 演化方向失控 / 单文化（EvoMap 教训）→ 观测 + 保守入档 + 多目标门控 + AVOID 保留失败面；把观测当信号不作积分。
- 验证被逃逸 / 空洞 → 机器可复现执行验证 + 白名单 + 独立评审者分离 + CI 复验（Behind EvoMap 教训）。
- token 膨胀 → `dsh-token-meter` 基线不变量 + as-needed 懒加载。
- 集体层信任 → 不用积分/自报；git+CI 机器闸；维护者仲裁。

**未决问题（需拍板）**
0. **实施载体**：新开独立项目（新仓，bootstrap 现有协作体系，旧仓冻结在 v0.6.0）还是在现有 `dsh-continual-evolve` 里重来？——倾向新仓（保实施稳定性 + 推倒重建纯洁性），待用户拍板。
1. **命名：已拍板（2026-09-05）——项目名 `Noogenesis`**（心智发生/智源发生：noogenesis＝心智的发生与持续生长，德日进谱系下集体知识演化过程；AGI 北极星词根，与 Gene 原语同源：gene→genesis→Noogenesis）。npm 包名与 `@noogenesis` org 当前空闲，注册前需再验一次。仍开放：中文正式名、基因库 repo 名、域名等 taxonomy 细分。
2. `validate.yml` 具体复刻哪些 `verify-*`（最小集先跑，还是全覆盖）。
3. 集体层首批"只读消费公开基因库"起步，还是直接开放贡献 PR（后者需维护者 + 免费 CI 额度管理）。
4. 是否保留"单人队列 → 共享"迁移开关（默认离线，显式接共享层）。
5. 与 `dsh-continual-evolve` 的边界：协议层放同一插件还是独立插件；及其与旧引擎的融合顺序（本设计不沿用旧体系决策，融合仅在架构定稿后）。

---

## 参考

- **DSH 设计哲学**：[Everything is a plugin（官方预览）](https://www.deepseek.com/harness/en/) · [Cordis 论文 arXiv:2608.25512](https://arxiv.org/abs/2608.25512) · [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [Cordis 内核](https://github.com/cordiverse/cordis)
- EvoMap：[evomap.ai](https://evomap.ai/) · [evolver](https://github.com/EvoMap/evolver) · [GEP 协议](https://evomap.ai/wiki/16-gep-protocol) · [蜂群智能](https://evomap.ai/wiki/10-swarm)
- Behind EvoMap（独立批判）：[arXiv:2605.25815](https://arxiv.org/abs/2605.25815)
- EvoX：[evox.group](https://www.evox.group/) · [evomap.ai/evox/beta](https://evomap.ai/evox/beta)
- JIT-Agent：[论文 2608.25593](https://arxiv.org/abs/2608.25593) · [仓库](https://github.com/bingreeky/JIT) · 本地报告 `/mnt/work/work/JIT-Agent_Research_Report_20260831.md`
- GEPA：[arXiv 2507.19457](https://arxiv.org/abs/2507.19457) · [gepa-ai/gepa](https://github.com/gepa-ai/gepa)
- AIDE²：[weco.ai 递归自改进](https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement)
- dsh-memory（AGI 长期记忆方向，取其"AGI 为终极目标"的取向）：[FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory)
- superpowers：[obra/superpowers](https://github.com/obra/superpowers)；竞品快扫见 `docs/research/product-pivot-landscape.md` §9
