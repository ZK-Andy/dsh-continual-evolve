# Agent Note: write-time-conflict-guard

Status: implemented

## Problem

写入路径没有内容级冲突防线：`evolve_add` 直写全局 store 时，与既有条目的近重复只有晋升路径（wrapup/fate 的 `filterPromotable`）能拦——直接 add、门禁规划产出的 create 全部绕行。2026-08-24 同类调研确认这是 mem0（写入时 ADD/UPDATE/DELETE 决策）与 graphiti（边失效）解决的标准问题；本项目 #11 候选 c（近重复合并）挂账至今即此缺陷的自知记录。矛盾条目共存会持续污染跨会话注入。

## Decision

在引擎唯一变更入口 `service.apply()` 装代码强制守卫，全局 scope 的 create 逐编辑比对同 kind 既有条目（复用 `mostSimilarEntry` 的 bigram-Jaccard，阈值分两档）：

- **≥ 0.8（CONFLICT_BLOCK_SCORE）**：任何副作用发生前 throw——错误信息点名既有条目并指示改用 evolve_update；快照与审计均不产生。
- **0.5–0.8（CONFLICT_WARN_SCORE）**：放行但给新条目 stamp 元数据键 `conflictHint = <kind>:<id>:<score>`，wrapup/fate 后续可据此合并；result 的 after 快照同步盖章保持审计一致。
- **豁免**：rollbackOf 再建（回滚重建出与后继相似的条目正是回滚的本意）；local scope 整体不设防（草稿空间，晋升路径已有自己的重叠政策）。
- **知情审批**：evolve_add 工具的全局审批问题文本前置相似度提示（⚠️ near-duplicate of … 建议改用 evolve_update），人在拍板前看得见风险；引擎守卫仍是最终裁决。

## Alternatives considered

- **mem0 式 LLM 写入决策**（每次 add 让模型判 ADD/UPDATE/DELETE）：违背「模型提议、代码保证」分层——相似性判定是机械属性，交给 LLM 既加一次调用成本又重引入自产自审。
- **自动改写为 update**：静默把 create 变异成对既有条目的修改超出调用者授权，惊讶成本高；拒绝+指路达到同样效果且行为可预期。
- **local scope 一并拦截**：local 是会话草稿空间，重复全局条目派生会话变体是合法工作流；只 stamp 不 block 都不需要。
- **update 动作也查**：更新把自己改成与另一条目相似是真实场景（合并整理），v1 不设防留待巩固循环（R3）处理。
- **阈值进 schemastery 配置**：沿用 BM25_K1 先例——内部调优常量先模块化导出，出现真实调参需求再升级为配置面。
- **复用 search.ts 的 BM25 做相似度**：BM25 是「查询对语料」的排序度量，不是「文档对文档」的对称相似度；Jaccard 已被晋升路径校准过阈值生态，且泛化 `mostSimilarEntry` 即零新增数学。

## Consequences

- 全局 store 的近重复从「事后靠 wrapup 兜底」变为「写入时代码拒绝」；矛盾共存只剩 warn 档且全部带可审计 hint。
- `RefinementResult.appliedEdits[i].after.metadata` 可能含 conflictHint——消费方按可选字段处理。
- 未来 R3 巩固循环可直接消费 conflictHint 与 usage v2 做批量合并提案。
- 分词器已于 2026-08-28 审计轮合并（`normalizedTokens` 内部改用 search.ts `tokenize` 的集合形态）——「本项目如何切词」单一真相源；0.6/0.8 阈值为判断值而非拟合值，重钉未产生漂移。

## Related

- [gap-analysis](../../../../docs/gap-analysis.md)：B2 冲突消解条目；#11 候选 c 由本守卫部分兑现（block 级），合并级仍待 R3。
- 上游参照：mem0 写入管线、graphiti 双时间线（2026-08-24 对照调研报告）。
