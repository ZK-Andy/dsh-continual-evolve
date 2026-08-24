# Agent Note: consolidation-command

Status: implemented

## Problem

全局 store 只进不出：R2 的写入守卫挡住了新增近重复，但历史存量与后续中等重叠（warn 档）都会带着 `conflictHint` 堆积；usage v2 的零使用信号也只在本地的 wrapup/fate 路径被消费（且 `zeroUsageEntries` 硬编码 `scope !== "local"`），全局侧没有任何整理通道——唯一手段是逐条手敲 `/evolve demote`。2026-08-24 调研中 openclaw 的 dreaming 与 letta 的 sleep-time compute 都指向同一缺口：离线批量巩固。

## Decision

新增 `/evolve consolidate [apply]`，纯机械提案 + 两段式人工确认，零 LLM 调用：

1. **扫描**（`src/consolidate.ts`，全部纯函数）：
   - **冲突对**：解析条目上的 `conflictHint`（R2 盖章），目标仍存在且双方未归档 → 提案归档**带 hint 的新条目**、保留被指向的既有条目（先到先得，数据零丢失——unarchive 可逆）；
   - **零使用陈旧**：全局条目 injection 计数为 0 且 `updated_at` 距今 ≥ 30 天（STALE_MIN_AGE_MS，与注入排序半衰期同量级）→ 提案归档；
   - 同一条目命中两类时去重合并理由（冲突理由优先）。
2. **两段式**：默认仅打印报告（候选表 + 理由）；`/evolve consolidate apply` 以当时最新状态重建计划后，把全部归档构造成**一个** refinement（单快照、单审计记录）经 `engine.apply` 批量落地。人敲下的 apply 命令即同意——与 `/evolve archive`/`demote` 的"人为调用即授权"惯例一致，而报告→应用的两阶段保证了先看清单再执行。

## Alternatives considered

- **并入 fate 门禁节奏自动跑**：fate 是 local 维度且带 LLM 分类；全局巩固用确定性规则即可，挂上门禁会多耗 token 且"自动归档全局条目"的惊讶成本过高——命令驱动让人在环。
- **LLM 合并内容再归档**（真·merge：把新条目独有信息并进旧条目正文）：需要模型改写，v1 不做——机械归档已消除注入噪声且完全可逆；内容级合并留给门禁规划器在常规 review 中自然发生。
- **复用 `usage.zeroUsageEntries`**：其内部硬编码跳过非 local scope，语义正相反；在其上加参数会波及 wrapup 既有调用方，独立实现三行谓词更干净。
- **自动定期执行（无命令）**：违背「人为调用即授权」；后台静默归档全局知识正是 R2 要消灭的那类惊讶。

## Consequences

- 全局 store 首次拥有批量化、可审计、可回滚的整理通道；conflictHint 与 usage v2 两个信号面自此闭环。
- 报告与 apply 之间无锁——两次调用间状态可能变化，apply 侧总是按当下状态重扫（宁可少归档不误归档）。
- 归档编辑保留既有全部元数据（含 conflictHint 本身），unarchive 后线索仍在。

## Related

- [gap-analysis](../../../../docs/gap-analysis.md)：B2 自动降权/遗忘的全局侧补全；#11 候选 c 合并级的过渡形态。
- R2 前置：implemented/feature/2026-08-24-write-time-conflict-guard.md（conflictHint 生产者）。
