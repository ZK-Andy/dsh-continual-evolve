# Agent Note: consolidation-merge-tier

Status: implemented

## Problem

R3 巩固循环对 conflictHint 冲突对只有一档处理：**归档带 hint 的新条目、保留被指向的原条目**。近重复（相似度 0.5–0.8）意味着 20–50% 的内容可能只存在于被归档的那条里——直接归档等于把这部分增量信息藏进冷储（injection 看不见，多数会话永远不会 unarchive）。#11 候选 c（同 scope 近重复自动合并）挂账至今。2026-08-28 生态调研确认反膨胀是各家标配（czs/dsh-evolve 的近重复合并+字符预算、pi-continuous-learning 的 dream 合并），见 `docs/research/pi-dsh-competitor-gap-analysis.md` §5.2 P1-2。

## Decision

`planConsolidation` 扩出**合并档**：`opts.mergeDuplicates` 开启时，conflict-pair 候选在被归档前先把内容**机械并入被指向的幸存条目**——

- `findConflictPairs` 的候选携带 `mergeInto`（指向幸存者的 kind/id/title）；staleness 候选永不合并（无重复语义）。
- 合并编辑 = 对幸存者的 update：`mergeContent` 把来源内容以带署名的分隔段追加（`[Merged from <kind>:<id> on <date> — near-duplicate consolidated]`），元数据盖 `mergedFrom` 数组（`<kind>:<id>` 串，追加不覆盖，保留既有 trail）。
- **同批多源组合**：update 的 content/metadata 是整体替换语义，两个 hint 指向同一幸存者时并行编辑会互相清写——planConsolidation 按幸存者累积（content 逐个追加、mergedFrom 逐个 push）后只发一笔合并编辑。
- 编辑顺序：合并编辑排在归档编辑之前（内容先落地，来源再隐退）。
- 批语义不变：仍是**一个** refinement（单快照单审计），rollback 的确定性逆操作同样覆盖合并编辑（幸存者内容/元数据可整体回退）。
- 命令面：`/evolve consolidate [apply] [merge]`——默认仍是纯归档（向后兼容），`merge` 显式开启合并档；报告里合并候选标注「→ 内容并入 <id>」。沿用「人为调用即授权」惯例，零 LLM、零弹窗。

## Alternatives considered

- **合并设为默认**：改变幸存者内容比归档一方侵入性高；`consolidate apply` 老用户的行为面不该静默变化。显式 `merge` 旗标成本一行、意图清晰。
- **去重后追加（只并 delta 文本）**：句子级/段落级 delta 判定对中文散文不可靠，切错边界比多存一份更糟；全文带署名追加零信息损失、unarchive 语义仍自洽，膨胀交给后续摘要/裁剪处理。
- **合并内容交给 LLM 改写**：违反 R3「纯机械零 LLM」设计底线（人为调用即授权的前提是没有第二双看不见的手在改内容）。
- **合并后删除来源条目**：删除不可逆，违背「归档保留数据、unarchive 可恢复」的 R3 根基；来源仍走归档。

## Consequences

- conflictHint 闭环补全：R2 盖 hint → R3 归档 + 并档，#11 候选 c 兑现。
- 幸存者可能因追加变长——注入节流（目录 15 行封顶）与既有 token 经济面不受影响；进一步瘦身留待摘要机制。
- `mergedFrom` 成为元数据键封闭集新成员，消费方按可选数组处理。

## Testing

- `test/consolidate.test.ts` 新增 5 例：关旗标行为不变（含 mergeInto 已在候选上）、开旗标后幸存者拿到署名内容+mergedFrom 且幸存者不被归档、双 hint 组合不互相清写、纯 staleness 候选不合并、引擎级单 refinement 落地验证。

## Related

- [pi/dsh 生态竞品差距分析](../../../../docs/research/pi-dsh-competitor-gap-analysis.md)：§5.2 P1-2。
- [consolidation-command](2026-08-24-consolidation-command.md)：本决定在其批架构上扩档，未改批语义。
- [write-time-conflict-guard](2026-08-24-write-time-conflict-guard.md)：conflictHint 的生产端。
