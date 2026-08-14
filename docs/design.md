# DSH 自进化插件设计方案（Continual Evolution）

> 基于对三个参照物的源码级研究：
> 1. **prime-agent /refine**（PrimeIntellect-ai，15.4k★）——`refinement.ts`（1017 行）已全文精读，是当前最接近生产可用的"harness 自我改进"实现
> 2. **penguin-harness**（Prism-Shadow，1.2k★）——benchmark 驱动的进化循环，纯提示词软契约（研究报告结论：仅适合研究）
> 3. **学术前沿**——Self-Harness（arXiv 2606.09498）、AHE（arXiv 2604.25850）、HarnessOpt-Bench（arXiv 2608.06301）
>
> **设计立场**：状态模型和工程纪律照抄 prime-agent（成熟、有测试背书）；验证层超越它——用 DSH 的沙箱/事件溯源/结构化子代理把"模型自觉"升级为"代码强制"。即 **prime-agent 的骨架 + penguin 报告的硬化清单**。
>
> 研究日期：2026-08-14。插件暂定名 `dsh-continual-evolve`（与现有 `dsh-evolve` 定位互补：它管"按需长能力"，本插件管"评估/轨迹驱动的持续进化"）。

---

## 1. 目标与非目标

### 目标
- 让 DSH agent 能**持久化**地从会话轨迹中沉淀可复用状态：提示词补充、记忆、技能、子代理规格
- 进化过程**可审计、可回滚、版本化**，写入即留痕
- 所有可机械化的保障（schema 校验、并发控制、权限隔离、快照）由**代码强制**，不靠模型自觉

### 非目标（v1）
- 不做 benchmark 评分闭环（那是 v3，见 §7）——先解决"进化本身可信"的问题
- 不改写任何 preset 的**基础系统提示词**（不可变基座，同 prime-agent 纪律）
- 不自动改核心 harness 代码（插件只能进化自身管理的状态）

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 契约层（模型可见）                                              │
│  · evolve 工具（evolve_add/update/delete/list/rollback）        │
│  · /evolve 命令（人工触发）                                    │
│  · system prompt 段落（order ~118，教进化姿态 + 何时该长）        │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 状态层（文件即数据库，照抄 prime-agent）                          │
│  · $DSH_HOME/evolve/harness_state.json   全局（跨会话）          │
│  · <session>/evolve/harness_state.json   局部（本会话）          │
│  · $DSH_HOME/evolve/refinements.jsonl    全局变更历史（可回滚）    │
│  · <session>/evolve/ 快照目录             应用前自动快照           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 执行层（DSH 现成基建，本插件的硬化来源）                           │
│  · agent/settled 事件 → 回合末串行应用（prime-agent 同款时机）     │
│  · dsh-subagent 结构化输出 → 提案 JSON schema 强校验              │
│  · 沙箱 → global 条目写入前权限门禁                              │
│  · 会话事件日志 → 轨迹即 evidence，天然可审计                     │
└─────────────────────────────────────────────────────────────┘
```

## 3. 状态模型（直接采用 prime-agent 的设计）

```ts
interface HarnessState {
  schema: 1;
  entries: {
    prompt:   Record<string, HarnessEntry>;   // 补充提示词段（基础提示词不可改）
    memory:   Record<string, HarnessEntry>;   // 持久事实/决策/失败/偏好
    skill:    Record<string, HarnessEntry>;   // 可执行技能（含 python 引用契约）
    subagent: Record<string, HarnessEntry>;   // 可复用委派规格
  };
  refinements: HarnessRefinementEvent[];      // 变更历史（证据链）
}

interface HarnessEntry {
  id: string; kind: "prompt"|"memory"|"skill"|"subagent";
  title: string; content: string; path: string;
  scope: "local"|"global";
  reference: Record<string, unknown>;   // skill 必填：{type:"python", import, callable, call_pattern}
  arguments: Record<string, unknown>;   // skill 必填：参数契约
  metadata: Record<string, unknown>;
  source: "evolve"; created_at: string; updated_at: string; version: number;
}

interface HarnessRefinementEvent {
  id: string; trigger: string; changes: string[];
  evidence: string;   // 来自轨迹的证据摘要
  outcome: string;    // 预期结果（可证伪）
  created_at: string;
}
```

### 采用理由（prime-agent 被验证过的设计点）
| 设计点 | 源码位置 | 价值 |
|---|---|---|
| 原子写（tmp+rename，保留 mode） | `saveHarnessState` | 崩溃安全 |
| 损坏降级为空（不 throw） | `loadHarnessState` | 坏文件不炸会话，下次重写干净 |
| 乐观并发控制（baseline 比对拒绝"planning 期间被改"） | `applyRefinementProposal` L726-740 | 多会话/多标签页安全 |
| 编辑级校验（action/kind 枚举、base_prompt 不可改、skill 必须带 reference+arguments） | `validateEdit` | **代码强制**，非法编辑逐条失败不整体作废 |
| 逆操作回滚（before→update/create、after→delete） | `rollbackProposal` | 回滚是确定性代码，不是 LLM 再猜一遍 |
| JSON 恢复（brace 切片 + 截断诊断） | `extractJsonObject`/`isIncompleteJson` | 模型输出鲁棒性 |
| 输出预算随模型 maxTokens 缩放 | `refinementMaxOutputTokens` | 小模型不被 32k 预算坑 |
| 提示词渲染封顶（6 条/类、5 条历史、180 字符） | `formatHarnessStateForPrompt` | token 成本有界 |

## 4. 触发时机（DSH 事件接线）

| 触发源 | 机制 | 说明 |
|---|---|---|
| **手动命令** | `/evolve [instructions] [--global]` | 用户显式要求，最优先 |
| **模型自觉** | `evolve` 工具（`refine.run` 同款 API） | 发现重复失败/可复用战术时主动调度 |
| **回合间隔** | `agent/turn-stopping`（计数）+ `agent/status`（idle 触发） | 每 N 回合（默认 6）跑一次**廉价 review 门禁**；计数器重启清零，每次判断写 `reviews.jsonl` 审计（见 FAQ #5） |
| **压缩时** | `session/event`（`compaction/start`） | 压缩前无条件跑一次门禁，把会被丢掉的经验先沉淀 |

### 关键纪律（照抄 prime-agent）
- **绝不在 step 中途打断 agent**：手动路径（`/evolve plan`、evolve 工具）在显式调用点同步 apply（带 baseline 比对，天然串行）；自动路径（门禁批准后）在 `agent/status` idle 之后异步串行执行——两种路径都不会打断进行中的 step
- **plan 与 apply 分离**：LLM 规划可能耗时数十秒，期间共享文件可能被别的会话写——apply 前必须重读 + baseline 比对
- **单回合一次**：门禁用 `lastReviewAt` 记账，间隔内不重复跑
- **review 门禁是独立廉价 LLM 调用**（4k token 预算、只读最后 40k 字符），决定"该不该进化"，而非直接进化

## 5. 验证层接线（DSH 相对两个参照物的结构性优势）

### 5.1 提案校验 —— 比 prime-agent 更硬
prime-agent 用 `validateEdit` 做代码校验，但提案是**主 agent 自己产出**的（LLM 调 LLM，自产自审）。DSH 方案：
- 提案生成走 **`ctx.llm` 流式调用**（与主 agent 同 provider/model，`reasoningEffort: "off"` 强制非推理输出，见 FAQ #7）+ `plan.ts` 的截断感知 JSON 恢复（`extractJsonObject`/`isIncompleteJson`），非法输出即判失败——而不是让模型自产自审
- 应用前仍跑一遍 `validateEdit`（双保险）
- 评估单元格走 **`dsh-subagent` `outputSchema` 结构化输出**（schema 校验是 DSH 内建能力）：provider 校验子代理回复，宿主从不解析模型文本（见 FAQ #3）

### 5.2 轨迹即证据 —— DSH 事件溯源是天然资产
- penguin 的 Trace 绑定靠 evaluator 自查；prime-agent 的 evidence 靠模型自觉摘要
- DSH 的会话日志是**事件溯源 + 严格回放**：`evidence` 字段可以引用 `seq` 区间（如 `evidence: "seq 120-135: 用户第二次纠正同一汇率表"`），审计时直接回放对应事件，无法伪造
- 提案的 `rationale/expectedOutcome` 要求可证伪（照 penguin 的假设纪律 + AHE 的"决策可观测性"）：每条 edit 必须预测"哪个可观察行为会变、为什么"

### 5.3 范围隔离 —— 沙箱强制而非自觉
- **local 条目**：只写当前会话目录，无风险，直接应用
- **global 条目**：写入 `$DSH_HOME/evolve/` 前必须过**人工审批门禁**（复用 `dsh-plan-mode` 的评审机制或 `ask_user`），v1 不放开纯自动 global
- **skill 条目**：只允许创建到 `$DSH_HOME/skills/`（`dsh-skill-filesystem` 已有发现机制），路径规范化校验防穿越（penguin 唯一有的硬保障，DSH 原生就有）

### 5.4 快照与回滚 —— 钩子化而非指令
- apply 前由插件**自动**快照受影响的 harness_state.json（写钩子，模型无权跳过——对应 penguin 报告改造清单第 4 行）
- 回滚走确定性逆操作（§3 的 `rollbackProposal`），`evolve_rollback <refinement_id>` 一键还原
- global 变更历史 `refinements.jsonl` 跨会话可回滚；local 历史随会话 JSONL 持久（DSH 回放机制天然支持）

## 6. 与 DSH 现有能力的映射（实现清单）

| DSH 现有插件/服务 | 本插件如何用（实现状态） |
|---|---|
| `agent/turn-stopping`、`agent/status`、`session/event` | 回合计数 + idle 触发门禁 + `compaction/start` 压缩前 review（已实现，见 §4） |
| `ctx.llm`（流式）+ `dsh-subagent` | 提案生成走 `ctx.llm` 流 + JSON 恢复；评估单元格走 `outputSchema` 结构化输出（均已实现） |
| `dsh-skill-filesystem` | skill 条目落盘 `$DSH_HOME/skills/<kebab>/SKILL.md`（插件自写，发现机制复用 DSH 的） |
| `userQuestions` | global 进化的人工评审门禁（`approval.ts`，等价替代 dsh-plan-mode） |
| 插件自带 `store.ts` | local/global 变更历史 JSONL + 快照 + 回滚源（不依赖 dsh-session-persistence-jsonl） |
| `dsh-evolve` | v2 可选：把进化结果以热挂载 cordis 插件落地——**已实现**（`src/mount.ts`：`/evolve mount <skillId>` 把 skill 条目渲染为插件包并用 loader 热挂载，重启后按 ledger 自动恢复） |
| `dsh-agent-presets` | prompt 条目渲染进提示词层（`systemPrompt.section` 直接注册，additive，不动基座；已实现） |
| `dsh-goal` | v3 可选：进化循环的轮次驱动——**已实现**（`src/goal.ts`：`/evolve goal` 创建/编辑会话 goal；active goal 时自动 review 门禁**每轮**触发，由 goal 轮次机器驱动，完成/阻塞即停） |

## 7. 分阶段路线

### Phase 1 —— MVP（照抄 prime-agent 骨架子集）
- [x] 状态模型 + 原子读写 + 损坏降级 + 乐观并发（`src/state.ts`：tmp+rename 保留 mode、坏文件降级空、baseline 比对拒绝并发改）
- [x] `/evolve` 命令 + `evolve_add/update/delete/list/rollback` 工具（`src/command.ts` + `src/tool.ts`，另有 export/import 备份恢复）
- [x] 回合末串行应用 + 自动快照 + 逆操作回滚（`src/service.ts` apply 前 `snapshotBefore`；`src/rollback.ts` 确定性逆操作；手动路径显式调用点同步 apply，自动路径 idle 后异步，见 §4）
- [x] 仅 local scope；global 只读展示（Phase 2 起升级为 global 人工审批可写）
- **验收**：真实会话中长出跨会话可复用的 memory/skill 条目，可回滚，坏 JSON/非法编辑全部代码级拒绝（已达成并有运行证据）

### Phase 2 —— 门禁与自动化
- [x] turn_interval / compact review 门禁（廉价 LLM 调用）
- [x] global scope 开启，带人工审批门禁
- [x] skill 条目可执行化（对齐 prime-agent 的 python reference 契约，物化 `$DSH_HOME/skills/<kebab>/SKILL.md`）
- [x] **prompt 条目真正注入系统提示词**（additive section，封顶 6 条/类）——`src/inject.ts` 的 `entriesSectionText` 在 `index.ts` 注册为 `tool:continual-evolve:entries` 动态 section（order 118+1）：text 是 provider，每次 assembly 用 `context.agent` 定位会话，读 global + 沿 `SessionHeader.parentSession` 链最近非空 local store 合并渲染；空 store 渲染为 "" 被 prompt renderer 丢弃，零 token 成本；全量仍由 `evolve_list` 提供
- [x] **subagent 条目生成可复用委派规格**——同一 section 把 subagent 条目渲染为 Delegation Specs 块（"委派时按规格组装子代理提示"）；子代理组装系统提示词时沿 parentSession 链继承父会话的 prompt/subagent 条目，无需包装 provider——委派接缝即全局 section + 链继承

### Phase 3 —— 验证闭环（penguin 硬化版，可选）
- [x] 评估矩阵执行器（改用 host 平面 `ctx.subagents` + `outputSchema` 结构化输出；web profile 无 host workflowEngine，见 FAQ #1）
- [x] scoreboard 聚合下沉代码（模型只产细胞级分数）
- [x] 接受规则：顶层平均分严格高于 Reference 且无退化（Self-Harness 的非退化规则，`src/score.ts` `decide`；拒绝时命令行提示回滚候选，人工在环）
- [x] rubric 目录对优化器不可读（沙箱 ACL，权限强制）——**已实现**（`src/rubric.ts`：rubric 明文永不着盘，落盘为 AES-256-GCM 密文信封；唯一解密点在宿主评估路径（`evaluate.ts` 注入子代理提示词前），优化器/主 agent 读 benchmark 文件只能看到密文；密钥优先级 config `rubricKey` → 环境变量 `DSH_EVOLVE_RUBRIC_KEY` → dev 默认键；旧明文文件透传兼容）

## 8. 风险与权衡

| 风险 | 缓解 |
|---|---|
| **token 成本**：review 门禁 + 规划都是 LLM 调用 | 门禁预算 4k token；渲染封顶；可配置关闭自动 review |
| **反馈回路漂移**：进化条目互相强化，偏离基线 | 版本化 + evidence 可证伪 + 定期人工抽查 global 条目 |
| **污染扩散**：global 条目影响所有未来会话 | v1 人工门禁；skill 只落 `$DSH_HOME/skills` |
| **多会话写冲突** | 乐观并发（baseline 比对），冲突即拒绝该 edit 不整体失败 |
| **模型自评不可信**（penguin 的教训） | Phase 3 之前，进化只做"沉淀"，不做"评分宣称"；expectedOutcome 记录为待验证假设 |

## 9. 参考材料

- 已精读：`PrimeIntellect-ai/prime-agent` 的 `refinement.ts`（1017 行，全文）、`harness.py`（819 行，结构）、`skills/refine/SKILL.md`、`refine/src/refine/__init__.py`
- 已精读：`Prism-Shadow/penguin-harness` 研究报告（工作区 `penguin-harness-self-evolution.md`）
- 论文：Self-Harness（arXiv 2606.09498）、AHE（arXiv 2604.25850）、HarnessOpt-Bench（arXiv 2608.06301）、Continual Harness（arXiv 2605.09998）
- 生态：`william-jin-cmu/dsh-evolve`（热挂载机制）、`LoserFox/distill`（对话蒸馏）
- 精读产物已存：`/mnt/work/work/research/prime-agent/`（refinement.ts / harness.py / refine_init.py）
