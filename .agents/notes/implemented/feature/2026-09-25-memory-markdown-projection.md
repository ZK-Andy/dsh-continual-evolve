# Agent Note: 记忆 Markdown 可读投影

Status: implemented

## Problem

记忆只活在 JSON store 里，人想"看一眼记了什么"只能读 `harness_state.json` 或等注入。ZCode 对标（`docs/research/zcode-memory-parity-analysis.md` §4.3）要求 JSON 为唯一事实源之外，再有一层 `MEMORY.md` 索引 + 单事实可读文件作为信任层；且投影必须由成功应用后自动生成、回滚/归档同步，模型不能绕过引擎直接写。

## Decision

- 新增 `src/projection.ts`：`materializeMemoryProjection(stateDir, state)` 全量重写 `<stateDir>/MEMORY.md`（一行一条：scope:id、标题、type、版本、归档标记、文件指向）与 `<stateDir>/memory/<id>.md`（frontmatter：id/scope/memoryType/version/path/archived/时间戳 + 标题正文）。
- 接入点选在 `EvolutionEngine.apply()` 落盘后（prune 块之后），仅当本批次有成功应用的 memory 编辑时触发：工具写入、Memory Agent 写入、remember/forget、archive/unarchive、rollback 全走同一 apply，天然同步；非 memory 写入不碰投影。
- 归档条目保留文件并标 `archived: true`（与召回/注入的默认隐藏语义对齐）；删除条目清扫其文件；游离文件（旧布局残留）顺手清扫。
- 文件名把 `:` 映射为 `_`（legacy `local:…` id 可落盘），映射碰撞加 `~n` 后缀、索引按实际文件名指向；文件 0600（与快照同纪律，记忆可能含用户隐私）。
- 投影失败走 prune 同款 best-effort（JSON 仍是事实源，下次 memory 写入重试），catch 命名吞掉的是"派生视图滞后"，不是数据丢失。
- 回归：`test/projection.test.ts`（5 例：索引与 frontmatter、归档标记与删除清扫、非 memory 不投影、rollback 同步、冒号映射与游离清扫）。

## Alternatives considered

- **挂在 `hooks.onApplied`（index.ts 插件层）**：直接调 engine 的测试与脚本拿不到投影，且 rollback 同样走 apply、hook 并无额外覆盖；引擎内聚更强，拒绝。
- **增量更新（只写变更条目）**：apply 内已有全量 post-apply state，全量重写 O(百级小文件）简单且天然消灭游离文件；store 规模（数十~数百条）下增量省不下可感知的 IO，拒绝。
- **归档即删文件**：归档语义是"隐藏但可恢复"，删文件会让投影与"可 unarchive"矛盾；保留并标记，拒绝。
- **照搬 ZCode 的 Markdown 主写**：双事实源会绕过审批/版本/回滚/审计（专用 Agent ADR 已否决）；投影永远派生，拒绝。
- **投影失败即 apply 失败**：派生视图不应否决已通过全部校验的写入；JSON 权威 + 下次重试足够，拒绝。

## Consequences

- 每次 memory 落盘多 O(n) 个小文件写；`export` 不含投影（重算即可），备份语义不变。
- 人现在可以直接读 `~/.dsh/evolve/*/MEMORY.md` 审计记忆；下次 P1（benchmark/回执/drain）与本次无耦合。
