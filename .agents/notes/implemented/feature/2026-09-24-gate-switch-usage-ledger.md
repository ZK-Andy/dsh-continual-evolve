# Agent Note: 门禁运行时开关与用量明账（#21）

Status: implemented

## Problem

- 门禁按 `cordis.patch.yml` 静态配置启停：关一次自动消耗要改文件 + 重启 dsh web，非技术用户够不着；#18a 归零实验的"闲置零消耗"也没有聊天内可操作的开关。
- 用量黑盒：`usage.json` 只有注入计数，没有任何面向人的账单面，"哪条记忆真被用过、哪条从没露过面"回答不了，#18a 的拍板缺数据。
- 宿主侧无插件设置面（`dsh-commands` 类型无 settings 概念），Web 设置页不可排期；zcode 式 Markdown 双向手改有校验与冲突坑，不在本轮。

## Decision

- 新增 `src/runtime.ts`：`evolve/runtime.json`（`{version, paused, updatedAt}`）+ 原子写 + 缺失/损坏 fail-open 为运行态（暂停是例外态，坏文件绝不能把门禁静默锁死）。
- `/evolve pause | resume` 写开关（幂等文案），手动 `evolve_*` 工具与命令不受影响（显式人操作不算绕过门禁）；`/evolve status` 一屏显示 patch 旗（`autoReview` 经 `CommandRuntimeOptions` 透传，旧接线显示 unknown）+ 运行时态 + 各 store 条数 + retention 预算。
- 门禁两处触发点（`agent/status` idle、compaction）先过内存间隔检查再读一次开关文件，暂停即静默休眠：无 LLM 调用、无 fate、无审计记录。
- `/evolve usage`：global + 本会话 + 本项目（如可解析）三源合并，按 `kind:id` 去重，注入次数倒排 Top 15（带 lastSession）+ 从未注入清单（20 封顶）+ 已删条目历史 key 计数；计数口径沿用 v2（会话数）。
- 只读 Markdown 镜像与 token 采集留待后步：前者待格式拍板，后者待确认 LLM 调用返不返回用量。

## Alternatives considered

- **开关进 `cordis.patch.yml` 只加文档**：落败。零开发但体验不变，P2 的诉求正是"不用改文件重启"。
- **暂停同时禁掉手动工具/命令**：落败。手动是显式人意图，禁掉等于把用户锁在门外；总闸只管自动烧 token 的部分。
- **暂停写审计记录（reviews.jsonl 一行 "paused-skip"）**：落败。暂停态每个 idle 都记一行，审计文件被无意义行淹没；可见性由 `/evolve status` 承担。
- **usage 合并视图（含 `local:` 前缀 id）展示**：落败。usage key 本来就是裸 `kind:id`，跨 store 同 id 去重后展示更贴近"这条内容被用了几次"的问题。
- **开关状态放内存（重启恢复）**：落败。重启即恢复运行态会让"关掉省 token"的用户在升级/重启后 silently 烧钱；文件持久才是开关语义。

## Consequences

- 聊天内即可关停自动消耗（`/evolve pause` 后门禁零 LLM 调用，compaction 路径同样休眠），`status` 可查，`usage` 可验哪条记忆真有用。
- 代价：新增运行时文件与三个子命令；门禁每次触发至多一次小文件读（暂停态）。

## Testing

- `test/runtime.test.ts`：缺席/损坏/畸形 fail-open、pause/resume 往返。
- `test/command.test.ts`：pause/resume 幂等、status 各态文案与计数、`usage` 计数（含同会话去重、lastSession、stale 与空账本）。
- `test/auto.test.ts`：暂停态下 turn-interval 与 compaction 双路径休眠（仅 armed 标记）。
- 全量：`tsc` 零错、`oxlint` 零警告、40 文件 645 测试全绿。
