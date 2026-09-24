# Agent Note: 批量删除与存储卫生（#19/#20）

Status: implemented

## Problem

- `evolve_delete` 是单条语义，跨会话写逐次进人工审批：清空 global 存量 26 条要点 20 多次允许。
- 冒号 ID 误删路：legacy 存储里存在字面 `local:…` id，S7 剥离逻辑（review audit 2026-08-28）对 update/delete 无条件剥 `local:`/`global:` 前缀，把字面 id 解析成并不存在的兄弟 id → `entry not found`，3 条被迫文件级直删。
- 历史无界增长：`global/snapshots/` 82 个完整拷贝 3.1M（占 global ~90%），`refinements.jsonl`/`reviews.jsonl` append-only 无截断；唯一有轮转的是 `plugin.log`。

## Decision

- 工具层（`src/tool.ts`）：`evolve_delete` 新增可选 `ids: string[]`，`id` 改为可选保留兼容；`collectDeleteIds(id, ids)` 合并去重（先 `id` 后 `ids`，首见序），两者皆空时抛错（删除绝不静默 no-op）。一批 = 一次 refinement + 一次审批，批准文案对多条列出 `N entries (…)`。
- 应用层（`src/apply.ts`）：非 create 编辑字面优先——目标 store 命中字面 id 直接用，缺席才剥 `local:|project:|global:` 前缀回落到合并视图寻址；create 仍剥离（剥离集补上 `project:`，防止视图前缀 baked 进永久 id）。
- 存储层（`src/store.ts`）：`HistoryRetention {snapshots, refinements, reviews}` + `resolveHistoryRetention`（缺席/非正数钳制回默认 20/500/500）；`pruneSnapshots` 按 mtime 删最老（仅 `.json`，unstatable 的保留不误删）；`pruneJsonlFile` 留尾 N 行，预算内只读不写。两者均为 best-effort，失败不阻断写入路径。
- 接线：`createEvolutionEngine(baseDir, hooks, {historyRetain})` 落盘后修剪快照与本 store 历史（含 rollback 经 apply 的路径）；`reviews.jsonl` 三处写入（门禁 `record`、boot 标记、`emitEvolveComplete`）同预算修剪；`/evolve import` 导入历史后同预算修剪；插件 `Config` 新增 `historyRetain` 对象透传引擎与门禁。
- `EvolutionEngine` 返回值新增 `retention`（已解析三元组），工具与命令的越权写入点（`command.ts` import、`tool.ts` 事件）沿用同一预算。

## Alternatives considered

- **`ids` 必填并删除 `id`（破坏式替换）**：落败。存量调用（测试、脚本、模型已学到的单删习惯）全走 `id`；可选叠加零破坏，老调用逐字节同行为。
- **保留逐条 refinement，只合并审批弹窗**：落败。逐条 refinement 仍产生多条审计记录与多个快照，与"一次清理"的审计语义不符；单 refinement 回滚一次即全恢复。
- **按字节大小轮转 JSONL**：落败。条目体量稳定时行数即 bound 磁盘，且行数窗口对读者（`failures.ts` 取最近失败）语义直接；字节阈值还要处理单行超大与截断行半截 JSON。
- **快照只留 1 个**：落败。并发写与连续回滚需要窗口深度；20 在"回滚可用深度"与"回收 ~90% 磁盘"之间折中，refinements/reviews 取 500 保住 `failures.ts` 的读取窗口。

## Consequences

- 批量清空类操作一次批准即完；冒号字面 id 可被工具正常删除（字面与剥离兄弟并存时字面优先，合并视图回落仍有效）。
- 每次写入后历史自动有界：快照 ≤20/store、历史 ≤500 行/store、审计 ≤500 行；默认预算下 `failures.ts` 的读取窗口不受影响。
- 代价：引擎构造器多一个可选参数，`evolve_delete` 的参数表多一个可选字段；既有调用零修改通过。

## Testing

- `test/apply.test.ts`：legacy 字面 `local:` 删除、字面/剥离并存时字面优先、`project:` 前缀回落三例。
- `test/tool.test.ts`：`ids` 批量一 refinement（含 history 长度断言）、`id`+`ids` 混传与逐条失败、全局批量一次审批计数、`collectDeleteIds` 单测（兼容/去重/空抛错）。
- `test/store.test.ts`（新建）：`resolveHistoryRetention` 默认与钳制、`pruneJsonlFile` 留尾与预算内只读、`pruneSnapshots` 留新删旧（非 `.json` 不动）、引擎多轮 apply 有界、默认 retention 暴露、`reviews.jsonl` 发射截断与事件往返。
- 全量：`tsc` 零错、`oxlint` 零警告、39 文件 635 测试全绿。
