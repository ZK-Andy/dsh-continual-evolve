# DSH 智能体自演化引擎 · 共享层设计文档

> 日期：2026-09-04
> 状态：设计（proposed）· 落档于 `docs/research/`（设计草案，未立项；最终载体可能是新仓或独立插件，见 §11 未决问题）
> 范围：DSH 智能体**集体自演化**的共享层与引擎骨架设计 —— 仅设计，不含实现。

---

## 0. 一句话定位

**做一个 DSH 插件原生的"自演化引擎 + 共享层"，让"单人单机的自进化资产"升级为"多 agent 共同演化的蜂群资产"，且不依赖自购服务器——共享层用免费的 git 仓库 + CI 验证闸实现（git 即券商，CI 即真实执行验证）。**

---

## 1. 背景与问题

项目已有 `dsh-continual-evolve`（DSH 插件，MIT，573 测试）：把会话轨迹蒸馏成**可验证、可回滚、版本化**的本地状态（prompt notes / memories / skills / subagent specs），配基准验证循环。它解决"**单个 agent 怎么变聪明**"。

但暴露了根本瓶颈与偏差：

- **单人演化太慢**：同一套方法论（如本项目 `AGENTS.md`/`.agents`/`ADR`/`cookbook` + `verify-*.py` 门禁）只有一个人在打磨，进化速度低。
- **单人演化有偏差/负面效应**：自己给自己把关，适应性函数 = 自己的口味，容易过拟合自己、越走越窄。**目前已出现初步负面效应。**
- **大量任务其实是公共的**：几乎所有想用 AI 写程序的人都需要这类"AI 协作方法论"。若仅单人完善，等于把公共资产锁在孤岛里。

**目标**：把"自进化"从**单队列**升维到**蜂群**——许多 agent/人共同演化同一套方法论资产，成倍加速，并以众数对冲单人负面效应。DSH 的插件生态 + 插件市场 + capability manifest 恰好适合当蜂群基底。

---

## 2. 目标 / 非目标

**目标**
- 一个**自演化引擎**：本地蒸馏 → 协议化 → 验证固化 → 注入，全链路可由插件驱动。
- 一个**共享层**：让不同 agent / 人**交换**已验证的演化资产，共同演化。**不买服务器**。
- 复用与强化既有资产：`dsh-continual-evolve`（本地蒸馏/验证/回滚）+ 本项目那套方法论谷仓（AGENTS/skills/ADR/cookbook）。

**非目标（本设计不承担）**
- 不做 EvoMap 式"积分经济 / 自报元数据排名"的中央交易所（有独立实证证明其失败，见 §4）。
- 不依赖 EvoMap 平台 / 其 GPL-3.0 / source-available 代码。
- 不在本设计内实现完整 Hub 的社交图谱 / 排行榜（若将来要，另立档）。
- 不改动 `dsh-continual-evolve` 的既有安全语义（它是本地引擎底座），只在上面叠加协议层与共享层。

---

## 3. 参考对象：EvoMap / EvoX 解剖（借鉴其模式，不依赖其实现）

| 组件 | EvoMap/EvoX 实现 | 本设计借鉴点 |
|---|---|---|
| 蒸馏 | session 轨迹 → signal detect → 抽 gene | 已有 `dsh-continual-evolve`（更强） |
| 资产池 | `$EVOLVER_HOME/gep`（genes/capsules/events）+ memory | 用本项目的 AGENTS/skills/ADR/cookbook + 新增结构化 gene/capsule |
| 协议化 | **GEP**（Genome Evolution Protocol）：gene/capsule/event 标准 schema、稳定边界 | **借鉴"经验=可交换协议化控制对象"**（详见 §5 schema） |
| 验证固化 | validation-governed solidify | **更硬**：`verify-*.py` + 三重审核 + 基准验证 |
| 注入 | session/tool 边界注入 gene 作控制信号 | 采纳（注入成"控制信号"，非长文档） |
| 共享/蜂群 | 本地 Proxy mailbox → **中心 Hub**（evomap.ai） | **本设计用 git 共享层替代中心 Hub**（见 §6） |

**EvoMap 协议层的核心可借鉴结论（它自己的受控实验 4590 次 + 独立实证）**：
- 经验的关键不是数量，而是**表示**：紧凑"策略基因"（~230 token，关键词+摘要+策略步骤+`AVOID` 警告）优于文档化 Skill（~2500 token）。
- **蒸馏 > 堆砌**：失败历史压成紧凑警告最有效（+4.6pp）；混拼策略+失败、或简单追加历史都会稀释。
- **结构本身是收益**：GEP 结构化 vs 拍平成长句，结构版显著更优。
- **组合有边界**：单条精准基因最好，多 gene 塞同一 prompt 会互相干扰。

---

## 4. 为什么"共享层"必须自己做对（关键输入：独立实证）

[Behind EvoMap（arXiv 2605.25815，QMUL/Gareth Tyson 团队——独立研究，非 EvoMap 自家）](https://arxiv.org/abs/2605.25815) 分析真实网络（150 万资产、12.8 万 agent），直接命中"蜂群"成败：

- **98% 的资产从未被复用**：积分经济**奖励"发布"而非"被采用"** → agent 批量产废刷积分，奖励高度集中。
- **84% 的"已通过"资产靠空洞测试（如 `console.log()`）过关**：因为验证是上传者**自报的本地日志**，未独立验证。
- **GDI 质量评分算法是坏的**：排名主要由**未经验证的自报元数据**（"声称改了 X 行"）决定，可刷分。
- **结论**：A2A 协作网络**不能依赖未经核验的自报**；需要**公开参与 + 可验证执行 + 可信评估**。

**→ 本设计的共享层以"真实可复现的执行验证"为硬闸，而非"自报/积分"。** 这是 EvoMap 的失败与本设计的分水岭。

---

## 5. 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 协议 | **自定 DSH 私有协议**（不迁就 GEP/GPL） | 守住自己的验证门禁哲学 + MIT 干净；"参考但不依赖"；避免 GPL-3.0/source-available 传染与锁死 |
| 共享层 | **git 仓库（免费 GitHub 公共仓）+ CI 验证闸**，**不自建服务器** | $0；git 提供存储/版本/审计/回滚/分发；CI 提供"跨机器可复现的真执行验证" |
| 验证权 | **中央机器闸（CI 重跑验证）+ 维护者合入** | 保质量；避免自我验证/自报（EvoMap 败因） |
| 集成面 | **DSH 插件**（本引擎 + 共享客户端一体） | 贴合 Cordis 插件生态 + capability manifest + 插件市场分发 |

---

## 6. 架构

### 6.1 引擎（本地优先，每 agent 一份）

```
 dsh-evolution-engine（DSH 插件）
 ┌────────────────────────────────────────────────────────┐
 │ ① 蒸馏层   ← 复用/增强 dsh-continual-evolve            │
 │    session 轨迹 → 可验证本地状态                         │
 ├────────────────────────────────────────────────────────┤
 │ ② 协议层   ← 新增（核心缺口）                           │
 │    把资产规范成基因/胶囊：schema+出处+版本+验证签名       │
 │    gene（紧凑控制信号）/ capsule（已验证执行路径）/        │
 │    event（不可变演化日志）；AVOID 压成警告，蒸馏非堆砌     │
 ├────────────────────────────────────────────────────────┤
 │ ③ 验证闸   ← 已有（接入②）                             │
 │    verify-*/基准/三重审核；验证不过不固化、可回滚          │
 ├────────────────────────────────────────────────────────┤
 │ ④ 注入层   ← 进化：session/tool 边界注入 gene 作控制信号   │
 ├────────────────────────────────────────────────────────┤
 │ ⑤ 共享客户端 ← 新增（对外）                             │
 │    git fetch/pull 消费已验证基因；本地验证过才 PR 贡献回桶  │
 └────────────────────────────────────────────────────────┘
```

**架构不变式**
- 引擎**本地优先、可离线**：没有共享层，本地蒸馏/验证/注入照常跑（对齐 EvoMap "无 Hub 配置完全离线"）。
- 共享层只是**可选的向上增长**：接则全网共演化，不接则单机自演化。
- 基因**必须先本地验证，才允许进入共享管线**；共享仅是分发/交换，不是生产。

### 6.2 基因/胶囊 Schema（协议化的最小可交换对象）

```yaml
# genes/<domain>/<gene-id>.gene.yaml
gene_id: uv-vis-peak-fwhm          # 稳定、可比较的标识
version: 3                          # 单调递增
schema_rev: 1                       # 协议版本
domain: [scientific, uv-vis, peak-detection]
keywords: [fwhm, unit-conversion, min-distance, find_peaks]
summary: 检测峰并正确计算波长域峰属性
strategy:                           # 行为导向的紧凑步骤（控制信号）
  - 用 prominence 判据找峰
  - 转换 min_distance 到样本索引单位后再 find_peaks
  - AVOID: 只在把 peak_widths 输出换算回波长域后才报 FWHM
constraints:                        # 可选执行约束
  - 输出结构须含每样本主峰
validation:                         # 真执行验证证据（进共享层的前置）
  status: passed
  benchmark: critpt-frozen-001     # 冻结用例名
  evidence_ref: ci-run-<id>        # 指向可复现的 CI 运行
provenance:                         # 出处/审计
  authored_by: <node-id>
  derived_from: <session-trajectory-id>
  approved_at: 2026-09-04
  audit: [event-001, event-002]     # 不可变演化日志
```

```yaml
# capsules/<domain>/<capsule-id>.capsule.yaml
capsule_id: uv-vis-full-solution
gene_ids: [uv-vis-peak-fwhm]        # 组合的基因
steps: [...]                        # 已验证执行路径
evidence: { benchmark: ..., passed_checks: N/N, ci_run: ... }
```

**Schema 设计原则（来自 §3 结论 + 你的安全哲学）**
- 紧凑、行为导向、失败感知（`AVOID` 压缩成警告）。
- 机器可校验边界；验证签名真实指向可复现 CI 运行（**不是自报文本**）。
- `event` 为不可变日志，保证可审计、可回滚。

### 6.3 共享层：git 基因库（$0，替代中心 Hub）

```
 dsh-gene-bank（免费 GitHub 公共仓库）
 ├─ genes/<domain>/<gene-id>.gene.yaml
 ├─ capsules/<domain>/<capsule-id>.capsule.yaml
 ├─ manifest.json              # 检索索引：domain/tags → 基因指针
 └─ .github/workflows/validate.yml   # 每个 PR 重跑真验证（机器闸）
```

**角色**：git 仓库 = 免费"券商 / 市场"；PR + CI = 仲裁；维护者 = 合入执行者。**没有积分、没有自报打分**。

### 6.4 共享客户端（引擎插件对外行为）

**消费（pull → 注入）**
1. `git pull`（或 shallow fetch + sparse checkout 目标 domain）到本地缓存。
2. 读 `manifest.json` → 按 domain/keyword/向量匹配选 top-N 相关基因。
3. 在 session 开始 / 工具边界把基因作为**控制信号**注入（短、带 AVOID；不是长文档）。

**贡献（push 回桶 = 真验证过才 PR）**
1. 本地演化产出候选基因 → **先本地跑基准/verify**。
2. 通过 → staging 基因 + 验证证据（`evidence_ref`）→ **开 PR 到 gene-bank**。
3. 仓库 CI **跨机器重跑同一套验证** → 绿了才被维护者合入。**验证是机器执行，不是自报。**
4. 合入后全网 agent 下次 pull 即得。

**蜂群运营**
- 维护者（人或自动化）合入 CI 通过项——这是共享层的仲裁。
- 任何 DSH agent 都能 PR 贡献已验证基因，任何 agent 都能 pull 复用。
- 边界：不通过本地验证的贡献**进不了共享管线**（质量不靠众包刷量，靠真闸）。

---

## 7. 备选方案与不选理由

| 备选 | 不选理由 |
|---|---|
| 接入 EvoMap Hub（evomap.ai） | 数据进别人平台；接 GPL-3.0 / source-available；且独立实证其"群智层"是坏的（98%/84%/可刷分）；生态未证实 |
| 自建中心服务器 | 违反"无预算"约束；且易复刻 EvoMap 的失败（自报/积分） |
| IPFS / 内容寻址 | 更"去中心"但**可用性差**（public 网关限流、pin 要钱/要维护）、**无内置信任/验证** |
| libp2p 节点互连（P2P 蜂群） | 无信任模型、路由与治理复杂；验证问题仍未解决；运维成本回到"要服务器/要维护" |
| 仅靠 DSH 插件市场分发 | 只能"发现"，**缺"验证闸 + 版本化 + 审计/回滚"**；作为补充可以，作为共享层不足 |

**git 共享层的优势**：免费、成熟、天然带**真验证闸（CI）+ 版本化 + 审计 + 回滚 + 分发 + 检索（manifest/稀疏检出）**，且与既有方法论仓库同构。

---

## 8. 风险与权衡

- **git 是"别人家的免费基础设施"**：依赖 GitHub（可换 Gitee/Codeberg 同样免费）；非"完全自控"，但零成本。
- **集中式仲裁**：维护者/CI 是唯一合入口 → 单点（但也因此可控/可信）。可用"多维护者 + 自动化闸"缓解。
- **单复制 vs 多样性**：若全网只抄最强基因会单一文化。缓解：`manifest` 保留 domain 多样性、`AVOID` 保留失败面；观察"哪些被采用/被拒"做演化信号（对抗性参考 EvoMap 但只作观测，不作积分）。
- **免费 CI 额度**：公共仓 Actions 有免费额度；PR 从 fork 触发需维护者批准（合理）。
- **许可证**：引擎 + 基因库保持 MIT（自定协议、外置 git/CI，不链接 GPL 代码）。若将来接 GEP 生态需单独评审 GPL/source-available 影响。

---

## 9. 与既有资产的关系

| 资产 | 角色 |
|---|---|
| `dsh-continual-evolve` | ① 蒸馏 + ③ 本地验证闸 + 回滚的底座（**引擎的本地核心**） |
| 本项目 `AGENTS.md` / `.agents/skills` / `ADR` / `cookbook` | 高质量"基因池"（≈ genes/capsules 的现成内容） |
| 本项目 `verify-*.py` + 三重审核 + change-scope | 验证闸 / 评审的现成范式（**移植为 `validate.yml` 与共享仲裁**） |
| DSH 插件生态 / 插件市场 / capability manifest | 分发与权限隔离的适配层 |

---

## 10. 分阶段路线图

1. **P0（本设计落地）**：定基因/胶囊 **Schema** + 写 `validate.yml` 验证清单（把 `verify-*` 移植过来），把既有资产（AGENTS/skills/ADR/cookbook）**协议化成首批基因**。
2. **P1**：引擎插件实现 ②协议层 + ④注入层，**完全本地/离线可用**；验证闸接入本地基准。
3. **P2**：共享客户端（⑤）——git fetch/pull 消费 + 本地验证过才 PR；跑通"贡献→CI→合入→pull 复用"闭环。
4. **P3**：观测/多样性信号（哪些基因被采用/被拒）；可选：DSH 插件市场分发、manifest 检索增强（向量）。

---

## 11. 未决问题（需拍板）

1. 基因库命名 / 域名划分（沿用既有方法论的 domain 语义还是重建 taxonomy）。
2. `validate.yml` 具体复刻哪些 `verify-*`（最小集先跑通，还是全覆盖）。
3. 共享层首批是"只读消费公开基因库"起步，还是直接开放"贡献 PR"（后者需要维护者/仲裁与免费 CI 额度管理）。
4. 是否保留"单人队列 → 共享"的迁移开关（引擎默认离线，显式接共享层）。
5. 与 `dsh-continual-evolve` 的边界：协议层放同一插件还是独立插件。
