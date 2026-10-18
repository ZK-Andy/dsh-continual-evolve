# Agent Note: archive-visibility

Status: proposed

> 放置路径：本文件（`.agents/notes/proposed/architecture/2026-10-18-archive-visibility.md`）。
> 2026-10-18 功能史盘点后提出：归档行在用户侧完全不可见，且归档原因被 `status` 一个字段吞掉。

## Problem

记忆"消失"后没有任何用户可见的去处。现状：

1. **卡片只列非归档行**。`listAll` 按 `status` 过滤，归档行不出现；工作区选择器也只看 active。用户问"我那条记忆哪去了"，界面上没有答案。
2. **`status='archived'` 混用三种语义**：提级到全局后留下的来源行、评审淘汰、降级退回。三者处置完全不同（提级来源是正常历史，评审淘汰是坏记忆，降级是放错家），却只能去 `review_log` 反查。
3. **`memories` 没有 `archive_reason` 字段**。实测 2026-10-18：28 条 active、5 条 archived，这 5 条全是提级来源（`scope=person` 4 条 + `project` 1 条），但库里没有任何一处能直接读出这个原因。
4. 这与产品主张（版本化、可审计、可回滚）冲突：审计账本在，用户却看不到审计结论的落点。

## Proposal

### 1. 加 `archive_reason` 列

`memories.archive_reason TEXT NOT NULL DEFAULT ''`，取值封闭：

| 值 | 由谁写 |
|---|---|
| `promoted-source` | 提级事务归档来源行（`store.promoteMemory`） |
| `review-archive` | 评审判词 `archive` 落盘（`review` 应用链） |
| `demoted-source` | 降级/退回时归档的来源行（tiering 出口） |
| `merged-duplicate` | 合并去重归档（若日后实现） |
| `""` | 尚未分类（迁移占位） |

写入点与状态变更同事务；`applyProposals` 的 delete 仍是物理删除、不走归档（删除永远人工的语义不变）。

### 2. 一次性回填

迁移只加列，不猜原因；回填脚本按 `review_log` 与提级事务留下的判词行投影出已知原因（`promote` → `promoted-source`），无法判定的留空。

### 3. 卡片只读「已归档」区

记忆卡新增只读区，列出该工作区的归档行：id、标题、原因（空显示「—」）、归档时间，最多 50 条，不提供恢复/编辑/删除按钮。恢复仍走账本快照（`extraction_log` / `review_log` 的 before/after），这是既有能力，不新增机制。

## Alternatives considered

- **读时从 `review_log` 反查原因，不加列**：省一次迁移，但提级来源与降级来源没有对应的终态判词行（判词是 `promote`，不是"归档"），反查得到"为什么被提级"而不是"为什么被归档"；且卡片每个归档行都要 join 账本，读路径变重。落败原因：语义对不上，代价转移给读者。
- **单独开 `archive_log` 表**：信息更完整（谁、何时、什么原因、操作者），但等于给"归档"再建一套账本，和 `review_log` 重复记录同一件事。落败原因：重复账本，违背"业务事实只住各自的领域账本"。
- **只加列、卡片不做归档区**：库里有原因、用户看不到，仍然回答不了"记忆哪去了"。落败原因：解决了审计，没解决可见性；而这次提案的动机就是可见性。
- **提供"从归档恢复"按钮**：把只读投影变成写入口，绕过 `review` 与写门禁，等于复活 v0.11 的治理面。落败原因：物理/逻辑删除的恢复已有账本路径，UI 不该成为第二条写路径。

## Acceptance criteria

- 新归档行的 `archive_reason` 与 `status='archived'` 同事务写入，四类原因各有测试。
- 卡片能列出某工作区的归档行与原因，空原因显示「—」，上限 50 条且不提供操作按钮。
- 既有 5 条归档行回填后原因可读；无法判定的显示「—」而不是报错。

## Risks

- **schema 变更加迁移**：`memories` 已是 STRICT 表，加列的迁移必须与既有迁移链同风格（`ensure*` 幂等）。
- **枚举漂移**：归档原因会成为事实来源，将来新增出口（如合并）要同步扩枚举与卡片文案。
- **卡片信息量**：归档区会占版面；默认折叠或放在底部，避免把"当前记忆"挤下去。
