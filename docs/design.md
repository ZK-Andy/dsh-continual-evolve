# 设计：一条循环

> 本文档是项目的理念陈述与目标架构，写当前状态。三个时代的完整设计史与硬化清单见冷归档 [`docs/research/design-v1-2026-08-14.md`](research/design-v1-2026-08-14.md)；踩坑记录见 [`FAQ.md`](FAQ.md)；编码与结构规则见 [`coding-standard.md`](coding-standard.md) 与 [`architecture-standard.md`](architecture-standard.md)。

## 核心主张

**模型提议，代码保证。**所有机械化安全属性（schema 校验、快照、版本、回滚、审计、接受决策）由代码强制，不靠模型自觉。

## 一条循环

```
轨迹/对话 ──提议──▶ 代码门禁（validateEdit + 人工审批）──▶ 版本化 store（local/project/global）
                                                              │
        注入/物化（被动读：prompt section + 技能落盘）◀────────┘
              │
        验证（benchmark 闭环 / 确定性回滚 / reviews.jsonl 审计）─┘
```

## 提议的两条来源（地位不等）

- **对话直写（主）**：主会话模型按 when_to_save 指南经 `evolve_add` 直写——与 ZCode 记忆 UX 对齐（被动注入 + 低摩擦写）。成功回合零 LLM 成本。
- **时刻驱动提取（辅）**：专用 memory loop（受限工具闭集、冻结 manifest、双保险校验）只在四个低频时刻醒来——`compaction/start`、goal 连续受阻、会话收尾 drain、手动 `/evolve wrapup`——从轨迹增量补捞对话没有自发沉淀的跨轮模式。per-turn 后台提取已废除（2026-10-03 B 裁决：90% token 换 20% 产出、2% 落盘率，见 ADR `implemented/architecture/2026-10-03-refactor-baseline.md`）。

## 四条纪律

1. **ZCode 对齐边界**（ADR `zcode-parity-boundary`）：记忆 UX 层跟 ZCode（用起来像不像）；存储与治理层不跟、继续加厚（有什么）；接口面按判据逐条裁决。**ZCode 对齐的是"用起来像不像"，不是"有什么"。**
2. **残留退役**：一条路径被取代，同版本内删除 / 降级命名空间 / 改造吸收，三选一（architecture-standard §5）。机器门禁 `verify-architecture.ts` 强制：分层方向、禁环、host API 单点边界、规模预算，违标白名单只减不增。
3. **ROI 年审**：任何常驻后台自动化必须用 token 账（`token-usage.jsonl`）与产出账（`reviews.jsonl` + refinement 出处）证明 ROI，每次大转向时年审一次。
4. **人类观测窗**：斜杠命令面是治理层的人类窗口与应急阀门（pause/resume/status/log/export/import/rollback），不因"ZCode 没有命令面"而删；新能力默认进对话与模型工具。

## 关键设计决定（现状一览）

| 决定 | 内容 | 实现锚点 |
|---|---|---|
| 状态模型 | 三作用域（global < project < local 合并语义）、四类条目（prompt/memory/skill/subagent）、一个事实一个条目、memory 四型（user/feedback/project/reference） | `types.ts` |
| 写入路径 | 唯一变更入口，原子写、乐观并发、快照先于写入、逐条校验非法编辑不整体作废 | `service.ts` / `state.ts` / `apply.ts` |
| 回滚 | 确定性逆操作，不是 LLM 再猜一遍；拒绝自动回滚可选 | `rollback.ts` / `score.ts` |
| 审批 | project/global 写入必须唯一明确的"批准/拒绝"；丢失/畸形响应按失败重试，绝不记为拒绝 | `approval.ts` |
| 被动读 | prompt 条目与委派规格注入 system prompt（order 118/119）；记忆正文 order 400 注入 + 会话内冻结守 prompt cache；空 store 零 token | `inject.ts` / `memory-index.ts` |
| 技能物化 | skill 条目落盘 `$DSH_HOME/skills/<kebab>/SKILL.md`，可热挂载为 live 插件 | `skill.ts` / `mount.ts` |
| benchmark 闭环 | 两段式（执行者产证据 → 独立评审者评分）、rubric AES-256-GCM 加密、非退化接受规则、拒绝自动回滚、失败沉淀为回归用例 | `benchmark.ts` / `evaluate.ts` / `score.ts` |
| 退役 | consolidate 批量归档/合并、读时验证、晋升式退役（待办推进中） | `consolidate.ts` |
| 审计 | 每次判断写 `reviews.jsonl`；直属 LLM 调用记账 `token-usage.jsonl`；人类可读 `MEMORY.md` 投影 | `audit-log.ts` / `token-usage.ts` / `projection.ts` |

## 设计来源

- **prime-agent `/refine`**（工程形态）：状态模型、plan/apply 分离、逆操作回滚。
- **penguin-harness**（概念 + 硬化清单）：benchmark 驱动进化、"模型自评不可信"的教训。
- **ZCode 记忆系统**（UX 对标 + 提取内核）：被动注入、低摩擦写、专用受限提取器、一个事实一个文件（源码级分析见 [`research/zcode-memory-parity-analysis.md`](research/zcode-memory-parity-analysis.md)）。
- 学术：Self-Harness、AHE、HarnessOpt-Bench（纪律与验证闭环）。

完整对照表、采用理由与源码精读记录在冷归档 [`research/design-v1-2026-08-14.md`](research/design-v1-2026-08-14.md)。
