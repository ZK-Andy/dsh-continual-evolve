# Agent Note: 纯中文标题 slug 碰撞修复

Status: implemented

## Problem

`slug(title, kind)` 只保留 ASCII：纯中文标题归一化后为空，回退到裸 kind 名（`memory`）。于是第二条中文记忆 create 就撞 id，被判 `entry already exists`——per-edit 失败藏在 success 外壳里。影响 `/evolve remember` 中文文本、`evolve_add` 中文标题，以及后台 Memory Agent 的中文提案（一批两条中文 create 自相残杀一条）。用户以中文为主用记忆，此问题必现。

## Decision

- 改在 `slug()` 本体（一处改，三处调用点行为一致：`apply.ts` 落盘 id、`memory-agent.ts` 校验提示 id、`auto.ts` skill-consult 去重键）：归一化非空走 legacy 不变；为空时返回 `<fallback>_<sha256(raw)-8hex>`。同标题仍同 id（重复提交继续被拒），异标题不再共享 id。
- 新 id 形如 `memory_9f2c4a1b`，符合既有 id grammar（首字符 alnum、`_` 合法）；32-bit 碰撞边界远在 store 规模（数百条）之上，文档中声明。
- 存量 `memory` 条目不动：老 id 继续有效，新中文条目取 hash id，无迁移、无双轨读取。
- 回归：`test/types.test.ts`（新建：ASCII 不变、异中文异 id 且合 grammar、同中文同 id、hash 按 kind 分域）与 `test/apply.test.ts`（两条异中文同批全应用且 id 不同；同文重提仍 `already exists`）；`command.test.ts` 的 forget 多义测试改回纯中文标题，覆盖端到端。

## Alternatives considered

- **调用点各修各的（只改 `apply.ts`）**：`memory-agent.ts` 校验用旧算法会算出不同 id，validate 与落盘不一致；修本体保三处一致，拒绝分修。
- **拼音/音译保可读**：引入 transliteration 依赖（与零原生依赖原则冲突），多音字与中英混排边界复杂；hash 不可读但确定，拒绝。
- **remember 加显式 id 参数**：把命名负担推给人/模型，模型 id 质量不可控，且修不好 Agent 后台路径；引擎侧兜底才是根治，拒绝。
- **全标题 hash 化**：英文标题的 `dark_one` 可读 id 是既有资产（回滚链、MEMORY.md、用户引用），推倒重来损失大；只动归一化为空的分支，拒绝。
- **本次顺手发版**：用户明确只合 main 看效果；0.8.0 刚发，攒下一批再发，拒绝。

## Consequences

- 中文记忆连续写入不再丢；`MEMORY.md` 里中文条目显示 hash id（标题仍中文可读）。
- 残留：归一化非空但等价的标题（如 `深色-1` vs `深色_1` → 同为 `1`）仍碰撞——罕见且与本次无关，不修。
