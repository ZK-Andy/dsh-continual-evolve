# pi / dsh 生态竞品差距分析

> 调研日期：2026-08-28（gh api / npm registry 实时数据）。配套文档：`docs/gap-analysis.md`（对照 prime-agent + penguin 的 16 项能力差距，P0–P3 已实施完毕）；`docs/research/product-pivot-landscape.md`（#16 立项前决策全录）。本文回答两个问题：**两个宿主生态里谁在与我们赛跑**，以及**由此产生哪些补强动作**（结论已进 HANDOFF 待办 #17）。

## 1. 调研范围与方法

- **范围**：pi（badlogic/pi-mono，π coding agent 及其 fork 生态）与 dsh（deepseek-ai/deepseek-harness 插件生态）。
- **竞品判定标准**：与本项目任一能力域重叠——① 从会话轨迹沉淀状态（提示词补充/记忆/技能/子代理规格）；② 治理机制（版本化/审计/回滚/自动门禁/人工审批）；③ 验证闭环（benchmark/评估）；④ 记忆检索与巩固。
- **方法**：gh api 仓库与代码检索、npm registry 包数据、官方目录（pi.dev/packages、awesome-dsh-plugin）全文提取；每条结论附证据 URL。star 数与推送时间均为 2026-08-28 当日数据。

## 2. 生态总览

### 2.1 pi（扩展生态最大，无安全治理）

| 项 | 数据 |
|---|---|
| 主仓库 | [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — 98,609★ / 12,197 forks，2026-08-28 当天活跃；"AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI" |
| 扩展机制 | 两层：**Extensions**（`~/.pi/agent/extensions/` 或项目 `.pi/extensions/`，`/reload` 热加载；`registerTool` / 事件拦截 / `appendEntry` 会话持久化，[docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)）+ **Pi Packages**（extensions+skills+templates 经 `pi install npm:/git:` 分发，[docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)） |
| 包安全 | **无包级审查**——官方文档明示"extensions 执行任意代码，安装前需自行审查源码" |
| 生态规模 | 官方目录 [pi.dev/packages](https://pi.dev/packages) 共 5,359 个包；社区索引 [shaftoe/awesome-pi-coding-agent](https://github.com/shaftoe/awesome-pi-coding-agent)（97★，每日 CI 更新）收录 9,354 资源（7,997 extensions）；头部扩展月下载 62.8 万（pi-mcp-adapter） |
| 主要 fork | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 28,073★（60+ providers、31 内置工具，当天活跃） |

### 2.2 dsh（平台巨大，生态仅 18 天大）

| 项 | 数据 |
|---|---|
| 主仓库 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 201,471★，"Everything is a Plugin"，最新 push 2026-08-27 |
| 平台版本 | npm `@deepseek-ai/dsh` 0.1.1-rc.2（2026-08-21）；**npm 首发 2026-08-10**——生态仅 18 天 |
| 收录规模 | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 13,335★ 收录 **2,467 插件**（Memory 分类 80+、Skills 分类 60+）；[dsh-market](https://github.com/dsh-market/dsh-market) 2,664★ |
| 分发形态 | 少数发 npm 包，多数记忆/进化类只走 `dsh plugin add github:...` |
| 其他渠道 | 十余个第三方 awesome/市场列表（[AdamPlatin123](https://github.com/AdamPlatin123/awesome-dsh-plugins) 1,424★、[Anil-matcha](https://github.com/Anil-matcha/awesome-dsh-plugin) 988★、[0xsline](https://github.com/0xsline/awesome-deepseek-harness) 928★ 等） |

**结构性判断**：pi 是"扩展生态最大但无包级安全治理"的成熟市场；dsh 是"平台巨大但生态 18 天大"的窗口期市场。两个市场都**没有占据我们完整生态位的竞品**（§4 矩阵）。

## 3. 竞品清单

### 3.1 pi 生态

#### 重点竞品（按重叠度排序）

**① [MattDevy/pi-continuous-learning](https://github.com/MattDevy/pi-extensions) —— 唯一走完全链路的直接竞品**（130★，npm `pi-continuous-learning`，最近推送 2026-08-24，MIT）

- 机制：从会话 hook 事件（tool calls/prompts/errors/用户纠正）沉淀 **instincts**（原子化学习行为）；**置信度门禁**（初始 0.3–0.85，confirmed +0.05 / contradicted −0.15 / 每周被动衰减 −0.05）；`/instinct-dream` 全量巩固（合并相似、解决矛盾、删 stale）；`/instinct-graduate` **毕业机制**（≥7 天、置信 ≥0.75、确认 ≥3 次 → 晋升为永久 AGENTS.md 条目 / SKILL.md / slash command，28 天 TTL 清理）；低置信自动淘汰
- 缺口：**无全局人工审批、无版本化可审计状态层、无回滚、无 benchmark 验证闭环**（instinct 是可变 JSON）
- 同 repo 相关扩展：pi-blueprint（多会话规划+verification gates）、pi-code-review（编辑后自动 review）、pi-red-green（TDD 状态机）
- 灵感来源：everything-claude-code/continuous-learning-v2

**② [ThewindMom/pi-continuous-learning](https://github.com/ThewindMom/pi-continuous-learning) —— "候选/批准+回滚+毕业门禁"组合的唯一尝试**（0★，2026-07-21 后停更，未发布）

- 机制：自称 production-grade autonomous continuous learning——untrusted candidates 与 approved memories 分离存储；重复证据才产候选；本地 replay + canary 有正证据才 promote；有害记忆自动禁用；`/learn rollback`；显式毕业（候选/原始观察永不直写 AGENTS.md 或 skill）；归因记录（哪条记忆被注入过）
- 意义：0★ 无人使用——**该治理组合在 pi 生态是空位**

**③ [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) —— 下载量最高的"学习型"记忆**（npm `pi-hermes-memory` 0.9.6 / 2026-08-17，约 3.24 万下载/月，732 测试，MIT）

- 机制：自 Hermes agent 移植。SQLite FTS5 全会话搜索；MEMORY.md（≤5000 字符）+ USER.md + Pi 原生 SKILL.md 三层知识；**每 10 turn / 15 tool call 后台学习**；纠错即时保存；容量满自动合并（auto-consolidation）；记忆老化时间戳；**secret 扫描阻断密钥入库**；`skill_manage` 工具
- 缺口：无人工审批、无版本化/回滚、无 benchmark 验证

**④ [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) —— 记忆类事实标杆**（505★，npm v3.0.4 / 2026-08-11，MIT）

- 机制：会话进行中后台捕获 **Observations**（具体事件）→ 蒸馏 **Reflections**（持久事实），coverage 分级（none/partial/strong）作 dropper 证据；compaction 时确定性渲染已备好的记忆
- 定位：单会话内无限延续，不做跨会话 harness 状态。衍生：[k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole)（112★，合并 pi-vcc）、matthewfl/pi-contemplator（alpha，"二号大脑"背景审阅记忆账本——pi 生态最接近"反思循环"的机制，无持久版本化）

#### 其余 pi 竞品速览

| 项目 | ★ / 热度 | 机制要点 | 与我们的关系 |
|---|---|---|---|
| [jayzeng/pi-memory](https://github.com/jayzeng/pi-memory) | 137★，官方目录收录 | `~/.pi/agent/memory/` 纯 markdown（MEMORY.md+append-only 日志+scratchpad）；可选 [qmd](https://github.com/tobi/qmd) 三级检索；`memory_forget`/`memory_restore`（唯一内置删除可恢复） | 机制简单（agent 自主写），无门禁/评估/版本化 |
| oh-my-pi 内置记忆（[docs](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md)） | 28,073★ | 4 后端（off/local/hindsight/mnemopi）；local 产项目 summary+lessons（`learned.md`）+ skill playbook；mnemopi SQLite recall/retain/reflect/memory_edit | **刻意不做版本化可审计层**——定位"记忆是启发式上下文非权威，与仓库冲突视为 stale" |
| [arpagon/pi-rewind](https://github.com/arpagon/pi-rewind) | 107★（2026-03 后停更） | git-based 每回合 checkpoint、`/rewind` + diff 预览 + redo 栈 | 只回滚工作树+会话，不回滚 harness 状态 |
| [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system) | 145★ | 工具调用前权限执行/审批 | 运行时权限门禁，非记忆写入质量门禁 |
| [earendil-works/pi-review-loop](https://github.com/earendil-works/pi-review-loop) | 147★ | 持久增量 diff review 窗口 + review checkpoint | 代码 diff review，非状态沉淀 review |
| npm `pi-goal-list-loop-audit` | 2.6 万下载/月 | 独立 auditor 进程用"原始证据"复核任务完成 | 任务审计，非状态沉淀审计 |
| [reddb-io/red-skills-memory](https://github.com/reddb-io/red-skills) | npm v4.4.1 / 08-25 | "governed operational memory"：markdown notes+图记忆、零 token 召回、claim checks、生命周期 hooks | "治理"关键词最接近，偏企业知识库 |
| [AVIDS2/memorix](https://github.com/AVIDS2/memorix) | 703★ | 跨 agent（Claude Code/Codex/Cursor/Pi/omp）MCP 记忆层 | 跨工具共享层，无版本化/门禁（我们已拍板不做此方向） |
| [Signet-AI/signetai](https://github.com/Signet-AI/signetai) | 262★ | 跨 harness 同步记忆/AGENTS.md/转录/机构知识/secrets | 同上 |
| [ifiokjr/monopi](https://github.com/ifiokjr/monopi) | 148★ | pi 的一键安装器/发行版（extensions/themes/skills/swarm） | **分发渠道**非竞品；#16 潜在发布渠道 |

### 3.2 dsh 生态

#### 重点竞品（按重叠度排序）

**① [lispking/dsh-auto-evolve](https://github.com/lispking/dsh-auto-evolve) —— 机制同构度最高**（3★，npm `dsh-auto-evolve` 0.1.2，push 2026-08-25）

- 机制：**Observe→Propose→Validate→Apply→Rollback 五段闭环**；监听 `tools/result`/`agent/request-error` 收集信号；LLM 在**封闭 mutation 词表**（add/patch/retire × skill/post-processor/prompt-section/guard-policy）内提案；**沙箱子代理回放失败 episode 做基线对照，可度量改进才应用**；每次 mutation 记入**版本化 ledger 并保留 disposer 用于回滚**；成本预算门禁（per-cycle/daily）、停滞收敛暂停、回归冷却
- 缺口：无全局人工审批门禁；无 benchmark 驱动的显式验证闭环（用 episode 重放代替）；无检索/巩固层
- 定性：极早期（3★）不构成威胁，但**设计同构度最高**；其"沙箱回放验证"值得借鉴（§5 P1-3）

**② [GraySilver/dsh-evolve-modes](https://github.com/GraySilver/dsh-evolve-modes) —— "提议-人工审批"范式最成熟**（153★，npm `@graysilver/dsh-evolve-modes` 0.3.2，绑定 DSH 0.1.1-rc.2，有 CI）

- 机制：输入区四维组合控件（工作状态/思考策略/质量门禁/自进化）；每 N 次父回复（默认 3）触发**隔离学习请求**（专用 persona、不继承父会话、不带工具），证据必须逐字来自用户消息，产出规则提议 → **设置页人工逐条批准/忽略** → 写入全局 learned instructions（自动优化但不改动 AGENTS.md 文件本身）
- 缺口：只沉淀全局规则文本；无版本化状态层/回滚/benchmark/技能物化
- 可借鉴：隔离学习请求（防自产自审的另一个轴）、设置页审批 UX（§5 P2）

**③ [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) —— 同赛道热度第一**（256★，push 2026-08-24，无 npm，走 github 安装）

- 机制：五轨记忆（用户档案/全局事实/项目关键记忆/项目日志/每日日志）+ git 分支感知记忆 + 回合内自我审查（`reviewEnabled`，每 10 回合）+ 技能自我进化与管理器 + 四轨待办 + COI 调度/会话广播 + 提示词管理器 + **记忆 git 仓库同步（跨设备、分支隔离）**；写入需用户确认
- 缺口：无版本化 ledger/回滚/benchmark；审查是可选的回合内审查而非门禁流水线
- 定性："大而全"路线，与我们"窄而深"定位相反；git 同步可借鉴（§5 P2）

**④ [chenzheshushi-commits/dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) —— 门禁+反膨胀细节最细**（6★，GitHub tgz release v0.4.2，push 2026-08-25）

- 机制：六类条目（fact/preference/decision/lesson/todo/note，JSON 源 + Markdown 镜像）；bigram-Jaccard + FTS5 BM25 RRF 零 token 检索；**分级审批门禁**（按可逆性/冲突/重叠/是否溯源到用户原话决定自动确认或挂起审查，刻意忽略模型自报 kind）；重复观察强化；lesson 结晶为 **SKILL.md 且原地精炼带版本**；`active→stale→archived` 生命周期，**每次变更前备份、可回滚**；**反膨胀收敛**（近重复技能合并、字符预算）；回合末隔离 LLM 后台审查只提议不直写
- 缺口：无 benchmark 验证闭环；条目级备份而非状态版本轴
- 可借鉴：反膨胀收敛验证了我们 #11 候选 c 的价值（§5 P1-2）

**⑤ [william-jin-cmu/dsh-evolve](https://github.com/william-jin-cmu/dsh-evolve) —— 确认互补且停滞**（11★，最后 push **2026-08-13**，无 release、package.json `"private": true`）

- 机制：session 内按需长能力——`evolve_add` 把 cordis 插件源码落盘并热挂载、`evolve_remove` 可逆卸载、重启自动恢复；最后提交停在 8 月 12 日 DSH beta，**未跟进 0.1.1-rc.2**
- 定性：与本项目**互补**（它长"能力插件"，我们沉淀"harness 状态"），无竞品压力，潜在集成/收录对象

#### 其余 dsh 竞品速览

| 项目 | ★ | 机制要点 |
|---|---|---|
| [CraZY222123/dsh-self-evolve](https://github.com/CraZY222123/dsh-self-evolve) | 7★ | 三层记忆 L2/L1/L0 按 token 预算注入；遗忘/巩固/强化；纯代码挖掘零 LLM；v0.7.3 |
| [madage/dsh-self-improved](https://github.com/madage/dsh-self-improved) | — | L0 捕获→L1 抽取→L2 场景分组→L3 用户画像 + 技能合成，SQLite FTS5 + jieba |
| [Kytolly/dsh-evolve-in-git](https://github.com/Kytolly/dsh-evolve-in-git) | 3★ | 用户指定 git 仓库做记忆/技能草稿存储；v0.1.4+ Web 设置页 |
| [Atman-Angle/dsh-evolve](https://github.com/Atman-Angle/dsh-evolve) | 0★ | 旁路执行经验；经验默认只存检索，显式蒸馏+用户确认才成技能 |
| [beijingwahw/dsh-proactive](https://github.com/beijingwahw/dsh-proactive) | 4★ | 长期任务模式记忆 + 遗传算法策略进化 + 沙箱评估 + 金丝雀（主动调度向） |
| [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) | — | bounded/layered/**approval-gated/auditable** 跨会话记忆；typed `ctx.memory` seam + 零依赖 SQLite + 冻结快照注入 |
| [KLRSL/dsh-biomemory](https://github.com/KLRSL/dsh-biomemory) | — | 分级审批门禁 + 结构化审计 + 记忆代谢（dream）+ 语义召回 |
| [863683348/dsh-memory-setup](https://github.com/863683348/dsh-memory-setup) | — | **changelogged JSON**（变更日志式审计）+ 证据支撑 lessons |
| [icearia0219/dsh-memory-spaces](https://github.com/icearia0219/dsh-memory-spaces) | — | 记忆空间**版本化 + 来源溯源 + 发送前注入审查** |
| [GIT121995/dsh-memory-gate](https://github.com/GIT121995/dsh-memory-gate) | — | 权威门控 + 完整审计轨迹 |
| [Asher-2000/dsh-memory-connect](https://github.com/Asher-2000/dsh-memory-connect) | npm 0.6.1 | FTS5+RRF 召回；**时间上下文图（valid_from/until/supersedes、append-only 修正）**；信任模型（召回历史按不可信注入） |
| [FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) | npm 0.3.1 | 白箱 AGI 研究项目，全链路留痕可审计（定位研究人员） |
| [Co-Engram](https://github.com/Co-Engram/Co-Engram/tree/main/packages/dsh-plugin) | — | git Markdown 团队记忆，38 个记忆工具 + RPE 强化/衰减/睡眠巩固 |
| [agentscope-ai/ReMe](https://github.com/agentscope-ai/ReMe/tree/main/typescript)（阿里 AgentScope 系） | — | local-first **自进化**个人知识库，会话固化 Markdown + 每日整理 |
| [LoserFox/distill](https://github.com/LoserFox/distill) | — | 后台子代理反思 → skill create/update |
| [fuxin123z/dsh-skill-manage](https://github.com/fuxin123z/dsh-skill-manage) | — | agent 自管理技能，带删除守卫 |
| [akqwpeter-prog/skill-bartender](https://github.com/akqwpeter-prog/skill-bartender) | — | 技能供应链门禁：隔离检疫 + SkillSpector 扫描 + 人工批准安装 |
| [wzz3034026545/dsh-rule-manager](https://github.com/wzz3034026545/dsh-rule-manager) | 1★ | Web 面板编辑 AGENTS.md，LLM 拆分分层规则+技能 |
| [Hua1Q1nG/dsh-prompt-self](https://github.com/Hua1Q1nG/dsh-prompt-self) | — | 按 prompt profile 改写请求并自更新习惯/反幻觉规则（无审计/回滚） |
| [azure5100/huahua-dsh-record-replay](https://github.com/azure5100/huahua-dsh-record-replay) | — | 会话录制回放 → 自动生成可安装 SKILL.md |
| [MichengAI/dsh-skills-manager](https://github.com/MichengAI/dsh-skills-manager) | npm 0.1.30 | 跨 DSH 与本地 Agent 的技能安全加载管理（只管装载，不产出技能） |

#### 生态外大玩家（跨运行时）

| 项目 | ★ | 机制 | 威胁评估 |
|---|---|---|---|
| [Q00/ouroboros](https://github.com/Q00/ouroboros) | **5,719★**，push 08-28 | "Agent OS: the agent gets smarter on its own"：**面试门禁（interview-gated）、分阶段评估、预算化进化循环**，"评分命令和期望结果永不进入给 agent 的成功契约"（防作弊设计）；MCP server + 13 运行时，**有官方 dsh 插件**（`integrations/dsh-plugin`），也支持 `--llm-backend dsh` | **最大外部威胁**：进化循环+防作弊评估门禁；但走 MCP/技能问答面，不沉淀 harness 状态层。持续关注其 dsh 插件演进 |
| [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS) | 12,508★ | local-first、Markdown 原生、自进化的统一记忆层（跨应用/工具） | 跨 harness 通用记忆，非 dsh 原生；我们已拍板不做跨工具共享 |
| [zilliztech/memsearch](https://github.com/zilliztech/memsearch) | 2,523★ | Markdown + Milvus 统一 agent 记忆层，明确支持 DSH | 检索向，无治理 |
| [KongFangXun/sofagent](https://github.com/KongFangXun/sofagent) | 41★ | 企业 FDE 约束层：24 规则 git-diff 审计 + **自动快照回滚** + 规则注入 + **自进化**，以 9 个 dsh 插件 + MCP（66 工具）分发 | 企业约束面；审计+回滚+自进化三点重叠，值得关注 |

## 4. 能力矩阵

图例：✅ 完整 / ◐ 部分 / ❌ 无。基线为本项目 2026-08-28 能力（HANDOFF「当前状态」节）。

| 能力维度 | 本项目 | pi-continuous-learning | dsh-auto-evolve | dsh-evolve-modes | dsh-memory-evolve | czs/dsh-evolve | ouroboros |
|---|---|---|---|---|---|---|---|
| 版本化状态轴（快照+乐观并发） | ✅ | ❌（可变 JSON） | ◐（mutation ledger） | ❌ | ❌ | ◐（条目级备份） | ❌ |
| 变更审计 | ✅（reviews.jsonl + refinements） | ❌ | ◐ | ❌ | ◐ | ◐ | ◐ |
| 确定性回滚 | ✅（逆编辑） | ❌ | ✅（disposer） | ❌ | ❌ | ◐（变更前备份） | ❌ |
| 自动门禁（触发+审计+冷却） | ✅ | ◐（置信度阈值） | ◐（预算门禁） | ❌ | ◐（可选回合审查） | ✅（分级审批） | ✅（面试门禁） |
| 全局人工审批 | ✅（弹窗+冷却） | ❌ | ❌ | ✅（设置页） | ◐（写入确认） | ◐（挂起审查） | ❌ |
| benchmark 验证闭环 | ✅（两段式+失败格+case 生命周期） | ❌ | ◐（episode 回放） | ❌ | ❌ | ❌ | ◐（分阶段评估） |
| 技能物化热加载 | ✅（mount + ledger 恢复） | ✅（毕业→SKILL.md） | ✅（genome） | ❌ | ✅ | ✅（SKILL.md 精炼） | ✅ |
| 检索（CJK 友好） | ✅（bigram BM25） | ❌ | ❌ | ❌ | ◐ | ✅（RRF） | ❌ |
| 巩固/反膨胀 | ◐（R3 consolidate，无自动合并） | ✅（dream + TTL） | ❌ | ❌ | ◐ | ✅（合并+字符预算） | ❌ |
| 效价反馈（证实/证伪） | ❌（仅中性暴露计数） | ✅（confirmed/contradicted） | ❌ | ❌ | ◐（强化） | ◐（重复观察强化） | ❌ |
| secret 扫描入库拦截 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

矩阵两个结论：**没有任何竞品同时具备"版本化 + 回滚 + 审批 + benchmark"四件套**；secret 扫描在 dsh 生态**全员缺席**、pi 生态仅 pi-hermes-memory 一家有（未进矩阵列）——它是我们 P0 补强方向，做了即是两个生态里的稀缺硬安全属性。

## 5. 差距分析与补强清单

### 5.1 护城河确认（不需要结构性改动）

1. "版本化可审计可回滚 harness 状态层 × 自动门禁 × 全局人工审批 × benchmark 验证闭环"的完整组合在两生态均无人覆盖（§4）。
2. 治理层全面领先；记忆赛道极拥挤（dsh Memory 分类 80+、pi 官方目录 memory 关键词 20+ 包）但全部是"agent 自主写 markdown/SQLite"范式。
3. 竞品验证了既有拍板：跨 agent 共享记忆不做（memorix/signetai/EverOS 方向拥挤且稀释定位）；ouroboros 走技能问答面、不构成生态位冲突，其防作弊评估设计已被本项目 A1（评估者/评分者分离 + rubric ACL）覆盖。

### 5.2 补强清单（已进 HANDOFF 待办 #17）

**P0：secret 扫描入库拦截**（证据：pi-hermes-memory 有、dsh 生态全员缺席）

- 缺口：`promotion.ts` 三重守卫（项目专属标记/薄内容/近似重复）没有密钥模式检测；`/evolve mount` 物化生成代码前无检疫。我们是公开插件，条目晋升进全局 store 并物化成技能文件——`as_sk_…`/`ghp_…`/`AKIA…`/私钥块一旦沉淀就是真实泄漏面。
- 做法：promotion 单一咽喉加 secret 正则守卫（含 `as_sk_`、`sk-`、`ghp_`、`AKIA`、`BEGIN PRIVATE KEY`、Bearer token 等模式），命中拒绝晋升并指路手动处理；mount 物化前同检。
- 价值：代价最低、符合"模型提议，代码保证"、两生态稀缺的硬安全属性。

**P1-1：条目效价反馈闭环**（证据：pi-continuous-learning 的 confirmed +0.05 / contradicted −0.15 / 每周被动衰减；czs/dsh-evolve 的重复观察强化）

- 缺口：usage.json v2 只记"多少会话见过它"（中性暴露计数），B2 衰减只有 staleness，无"被证实/被推翻"信号。
- 做法：门禁/wrapup 的 LLM 分类管道（`parseWrapupAssessment` 同款严格解析）增加 contradicted 标签；负计数进元数据；fate 分类时负信号条目优先 archive。不新增模块，现有两段管道各加一档。

**P1-2：近重复自动合并（#11 候选 c 升级）**（证据：czs/dsh-evolve 反膨胀收敛；pi-continuous-learning dream 合并）

- 缺口：R2 守卫拦"进入时"重复、R3 巩固归档带 conflictHint 的对，但存量近重复没有合并路径。
- 做法：consolidate 的 apply 路径从"归档保留原条目"扩一档"合并为新 refinement"。#11 候选 c 当时拍板"随真实使用评估"——生态证据（反膨胀是各家标配）支持升级。

**P1-3：失败轨迹自动生成 benchmark case**（证据：dsh-auto-evolve 沙箱回放失败 episode 做基线对照；ouroboros 分阶段评估）

- 缺口：benchmark 闭环强但 case 靠手工添加；进化失败（门禁拒绝/回滚）不留回归资产。
- 做法：门禁拒绝/回滚事件触发，把该轨迹自动转为 draft 状态的 benchmark case（进现有 case 生命周期状态机，draft 本就不参与评估）。同时是 D2 继承度量最需要的数据来源。

**P2（可选，产品面，随 #16 节奏）**

- Web 设置页逐条审批（dsh-evolve-modes 153★ 同类最成熟主要靠这个 UX）——等 #16 立项后作 pro-content 卖点。
- 跨设备 git 同步（dsh-memory-evolve）——取决于多机需求是否真实。
- supersedes 时间链（dsh-memory-connect 的 valid_from/until/supersedes）——update 时留 replaced-by 元数据，顺手级。

### 5.3 明确不做

- **跨 agent 共享记忆**（memorix/signetai/EverOS 方向）——重申 2026-08-24 拍板：稀释"让 harness 越来越懂你"的单一生态定位与治理层投入。
- **ouroboros 式运行时进化/面试门禁**——不同生态位（技能问答面 vs harness 状态层）。

## 6. 结论与路线影响

1. **#16 立项背书**：两个生态都没有完整对位者；dsh 生态仅 18 天大、格局未定——"自进化开发框架"的窗口期判断成立。
2. **pi 是 Phase 1 潜在第二宿主（新增发现）**：extensions 支持热加载、与我们技能物化机制天然兼容；生态无包级安全门禁（我们的冲突守卫/物化检疫是天然差异化）；该生态位空位（最接近者 pi-continuous-learning 缺治理四件套）。发布路径现成：npm package → pi.dev 官方目录 + awesome-pi 收录 + monopi 渠道。
3. **威胁关注清单**：Q00/ouroboros 官方 dsh 插件演进（唯一有"进化循环+评估门禁"的外部玩家）；sofagent（企业约束面）；pi-continuous-learning 若补上治理层将成为 pi 侧直接竞品（当前无版本化）。
4. **补强动作**见 §5.2——P0 一项、P1 三项已进 HANDOFF 待办 #17；P2 随 #16 节奏评估。
