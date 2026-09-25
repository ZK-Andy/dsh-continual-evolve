# Agent Note: 定向 recall 与手动 remember/forget

Status: implemented

## Problem

注入的目录视图只有一行一条的索引，`evolve_list` 则倾倒整个 store；模型和人都缺少"按 query 精确读回完整记忆"的路径。ZCode 对标（`docs/research/zcode-memory-parity-analysis.md` §4.4）要求 `evolve_recall({query, kinds, scopes, memoryTypes, limit})` 返回完整内容、来源、版本和可能过时状态；同时用户需要显式的"记住/忘掉"立即路径，不经过后台提取。

## Decision

- 新增 `src/recall.ts`：`recallMemories(engine, context, filters)` 跨 local/project/global 读记忆（默认 kind=memory），机械过滤 kind/scope/memoryType/archived，有 query 时用注入同款 CJK BM25（`buildRelevanceIndex`/`relevanceScore`）排序、无 query 时按 `updated_at` 倒序，`scope:id` 精确命中加权（manifest 搜索先例）。limit 缺省 10、上限 50（非法值回缺省，不抛错）。
- 读路径诚实性：local 无 session id、project 无 project key、store 不可读时一律记入 `notes` 并返回，不静默丢 store；未知 kind/scope/memoryType 直接抛错。
- 命中携带完整内容、版本、时间戳、memoryType、conflict-hint（过时信号）、sourceSession/sourceSeqs（有则带），`formatRecallResult` 渲染给模型/人读。
- 新模型工具 `evolve_recall`（只读，不经过审批），description 明确"找具体东西时优先于 evolve_list"。
- 新命令 `/evolve recall [scope] <query...>`（同一引擎的人用面）、`/evolve remember <type> [scope] <text...>`（立即单条记忆写入，走引擎全部校验与审批；feedback/project 缺 Why/How 按 per-edit 失败返回，与 plan 一致）、`/evolve forget [scope] <query...>`（命中 0 条报错、1 条归档（可 unarchive 恢复）、多条只列候选不写）。
- 回归：`test/recall.test.ts`（9 例：空库、BM25 中文排序、无 query 时序、scope/kind/type 过滤、精确 id 加权、归档显隐、notes、limit 夹断与非法过滤、版本与渲染），`tool.test.ts`（3 例）与 `command.test.ts`（7 例）覆盖工具注册、remember 校验面、forget 单义归档/多义列单/无命中。

## Alternatives considered

- **复用 `searchMemoryManifest`**：它是冻结 manifest 上的轻量 token 交集排序，无 BM25 IDF、无跨 scope、无归档/type 过滤；recall 需要注入同款排序保证"召回与注入一致"，拒绝。
- **forget 直接删除**：删除不可恢复且破坏审计链；归档保留数据、可 unarchive、可回滚，删除仍走 `evolve_delete`，拒绝。
- **forget 多命中时逐个弹窗确认**：命令面一次一答最符合"不打扰"（用户 9-24 已抱怨频繁弹窗）；列单让人收敛 query 后重试，拒绝。
- **remember 自动推断 memoryType**：推断错误会污染分类（validate 咽喉的意义正在于此）；显式 type 把分类责任留给人，拒绝。
- **recall 默认含 archived**：目录与注入默认都隐藏归档；recall 与之对齐，`includeArchived` 显式开启，拒绝。

## Consequences

- 模型侧多一个只读工具，token 成本只在调用时产生；目录注入预算不受影响。
- 已知边界：纯中文标题经 `slug` 全归一化到 kind fallback id（如 `memory`），连续 remember 会撞 id（第二条按重复 id 被拒）。这是引擎既有 `slug` 行为，本次不改；测试用 ASCII 区分标题绕行，forget 的单义路径不受影响。
- P1 剩余：Markdown 投影、memory benchmark、统一回执与有界 drain。
