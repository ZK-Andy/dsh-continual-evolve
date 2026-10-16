# Agent Note: 卡片内评审设置区（同入口双卡）

Status: implemented

> 放置路径：`.agents/notes/implemented/feature/2026-10-16-card-review-settings.md`

## Problem

`review.*` 五个字段已全 `.volatile()`（2026-10-13），改 profile patch 下一轮 drain 即生效，但用户改一次要翻 `cordis.patch.yml`，对中文用户不友好。试运行调参（`dryRun` 开关、`dailyBudget/batchSize/staleDays`）因此全是手工改文件。

更关键的归类矛盾：工作区记忆卡按 `root` 分区切换，而 `review.*` 是插件全局配置，不分工作区。硬塞进同一个折叠框会导致记忆一多设置被顶到底、全局项跟着分区下拉走，语义是错的。

## Decision

同一入口（槽 `plugins.bundle.config`，同一页）放两块独立折叠卡，上下排：

1. 顶上是“评审设置”卡——全局，不随工作区切换，默认折叠；两个开关（`enabled/dryRun`）+三个数字（`dailyBudget/batchSize/staleDays`），显式保存/重置，`enabled` 行标“需重启生效”（挂载期判定，其余下一轮生效）。
2. 下面“工作区记忆”卡原样不动（下拉、搜索、预览）。
3. 后端：卡片 API 新增全局 `GET/POST review-settings`（不带 `root`，`src/surfaces/review-settings.ts`：严格校验、400/405/413/503/500 映射、64KB 上限、预解析 body 与 Node 流双形态）；读走内存 volatile 快照，写经 `configEditor.edit(entry, merge)` 原子写回 patch（`entry` 取自本 fiber，复用 default-model `saveSelection` 前例），串行排队；接线收进 `src/surfaces/card-mount.ts`（`index.ts` 只剩调用，保持 400 行预算）；`settings.configure({ auto: false })` 关宿主自动表单页；无 `webServer`/`settings`/`configEditor` 的宿主逐级降级。
4. 前端：复用 `.dce-card` 框体、色板 token、原生兜底、中英 locale；`GET` 404 隐藏设置卡。
5. 范围只含 `review.*`，分层 9 项不动。

## Alternatives considered

- **保持手改 patch，不做 UI**：零代码，但中文用户每次调参翻文件，与“插件越来越懂我”的维护立场相悖，且试运行收口本就需要高频调参。落败。
- **不关自动页，直接用宿主自动表单**：`review.*` 已 volatile，自动页开箱即用；但自动页入口与 bundle 页分离（行配置视图），用户要在两处找设置，且自动页形态不可控（中英文案、需重启提示）。落败——仍关自动页，卡片是唯一入口。
- **设置塞进现有记忆框内（同卡同折叠）**：改动最小；但全局项随分区下拉联动、记忆列表撑长后设置难找，归类错误。落败。
- **客户端直调 `configForms`**：省一条后端路由；但卡片 ctx 是否暴露 `configForms` 未验证（当前 `exports.inject` 只有 slots/locale/theme），且密钥修订、stale-write 语义全压到前端。落败——后端经 `settings/configEditor` 落盘，前端只做 dumb fetch（沿用 `loadCardModel` 形态，可测）。
- **后端直写 patch 文件**：绕开 `configEditor` 的文件锁、对账与校验，违背“配置文件是唯一真相源且只经宿主写回”。落败。

## Consequences

- `review.*` 调参从翻 patch 文件降级为卡片点按；`enabled` 改后需重启，其余下一轮 drain 生效（回归测试钉住：路由 8 条、校验、串行保存、插件级 editor 接线）。
- 486 测试全绿（+12），`index.ts` 回预算内；`design.md` 与双语 README 已同步双卡形态。
- 试运行复跑期间冻结参数的要求不变：UI 只是把手改换成点按，改了仍需商定并记账，否则分布对不齐。
- 桌面端（npm 实体拷贝）需发版后更新重启目检；`POST` body 双形态（预解析 Node 流，64KB 上限 413）、并发串行链、`entry` 缺失时 503 均已覆盖。
