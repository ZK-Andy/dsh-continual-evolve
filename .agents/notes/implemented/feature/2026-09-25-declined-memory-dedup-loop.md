# Agent Note: 被拒记忆提案的跨会话去重（拒绝回路 MVP）

Status: implemented

## Problem

Memory Agent 的 project/global 提案被拒后，只留下三处易失记录：内存 `GateState.memoryDecisions`（进程重启即失）、`decisionCursor`（per-checkpoint，跨轮即变）、`reviews.jsonl` 审计行（只有 scope 名，没有提案内容指纹）。于是同一类提案在新会话/重启后原样再弹。实测 20 次人工拒绝 vs 6 次批准（23% 命中），用户体感"频繁、口径宽"。逐例改提示词不可扩展（预算 3000 已用 2883）。

## Decision

- 新增 `src/declines.ts`：被拒记忆提案台账。条目 = scope + action + 标题/内容归一化指纹（sha256-16，与 `evaluate.ts`/`project.ts` 同口径）+ 拒绝时间。落盘 `<baseDir>/evolve/declined-memory.json`，上限 50 条（`MAX_DECLINED_MEMORY_LEDGER`，与 `FATE_CONSULT_COOLDOWN_TURNS` 同类常量口径），超限按时间丢最旧。
- `applyMemoryExtractionProposal` 在弹窗前查台账：同 scope 整批指纹精确命中 → 直接计入 declinedScopes、不弹窗，审计行注明 repeat-suppressed；落空 → 照常弹窗。
- 被拒后（`requestScopeApproval` 只返回显式批准/拒绝，unavailable 走抛错，故 declined 恒为真人拒绝）把本批指纹写入台账。
- 读失败/文件损坏 → 按空台账处理（= 现状照常弹窗，fail-closed）；写失败 → 调用方 warn 吞掉（抑制是优化，不得把一次拒绝变成报错）。与 `pruneJsonlFile` best-effort 同理。
- MVP 只做精确匹配；改述复活仍会弹窗（诚实局限，下一轮再议相似度）。

## Alternatives considered

- **相似度抑制（token overlap 阈值）**：误杀风险高（"中文正文"偏好 vs "中文标题"缺陷可能同词），阈值需调参，拒绝。精确匹配零误杀，defer 相似度到有更多 decline 样本后。
- **把台账并入 reviews.jsonl**：审计日志是 append-only 事实流，混入"状态"会破坏回放语义，且修剪语义不同（审计 500 行 vs 台账 50 条），拒绝。独立小文件。
- **decline 率自适应阈值（全局收紧/放宽）**：反馈回路慢、行为难预测（用户会困惑"为什么今天一个都不问"），且 20:6 样本下阈值拍脑袋，拒绝。先做确定性去重。
- **提案前把历史 declined 当负例喂模型**：占每轮 token（manifest 已 8000 预算），且模型负例遵循不稳定，拒绝。确定性代码守卫优先。
- **local 作用域也入台账**：local 不弹窗（无需批准），无打扰可省，拒绝。只覆盖 project/global。
- **继续逐例改提示词**：预算只剩 117 字符，且 N 例 N 行不可扩展，拒绝（上一轮 ADR 已阐明）。

## Consequences

- 同一批被拒提案跨会话/重启不再复弹；审计行保留 suppressed 标记以便观察。
- 新增 1 源码文件 + 测试；测试数/文件数徽章与 README src 布局行同步。
- 相似度匹配、decline 负例提示、费率自适应留待后续轮次，不在本轮 scope。
