# Agent Note: 评审设置 volatile 化与按轮读值

Status: implemented

> 放置路径：`.agents/notes/implemented/feature/2026-10-13-review-settings-volatile.md`
> 对应讨论结论（2026-10-13 会话）：可配置项先做后端配置化；卡片内的设置区延后，且只做卡片一份 UI。

## Problem

试运行期需要按观察结果调整评审参数，但两处都卡住：

1. **`staleDays` 根本不是配置项**——它硬编码在 `index.ts` 的 `createReviewScheduler` 调用里（30），`Config` schema 里没有这个字段，用户无从调整（想把「30 天回炉」改成「3 天」必须改代码发版）。
2. **即便在 schema 里的字段也调不动**：调度器在 mount 时把 `dryRun` / `dailyBudget` / `batchSize` 捕获成常量，改了配置要重挂载插件才生效。
3. 宿主侧已有完整的配置面（`ctx.settings` 把 Config schema 投影成表单、`ctx.configEditor` 原子写回 profile patch 并立即应用），但**它只认 schema 上标了 `.volatile()` 的字段**，且 volatile 的语义正是「不重挂载即生效」。

## Decision

- `Config.review` 的**全部字段标 `.volatile()`**，并新增 `review.staleDays`（默认 30）。`.volatile()` 是零成本押注：DSH 一旦发布按 schema 自动生成页面的客户端，这套 schema 直接投影成表单，不需要写 UI 代码。
- **调度器不再收值快照**：`ReviewSchedulerConfig` 改为 `read: () => ReviewSettings`，每次 drain 现读设置；`enabled` 仍是挂载期判定（关掉即不 arm）。
- **解包留在 `index.ts`**：`config.review?.x?.get() ?? REVIEW_DEFAULT_X` 是组装根的职责，`review.ts` 的领域层只见普通值——volatile 类型不渗进调度与批处理逻辑，测试也不必构造 Volatile 对象。
- **不引入第二条配置源**：将来设置界面走宿主 `configEditor` → profile patch（配置文件仍是唯一真相源），库不存配置。

## Alternatives considered

- **只把 `staleDays` 加进 schema、不标 volatile**：用户改了仍要重启，且将来接设置界面时该字段依旧不可编辑，等于返工。落败。
- **把 config 引用直接交给调度器、在 `review.ts` 里 `.get()`**：volatile 类型与解包逻辑漏进领域层，测试要造 Volatile 对象，比现在的 `read()` 缝更重。落败。
- **配置写进 SQLite 库**：造成 patch 文件与库双真相源，且违背「代码是库唯一写者」。落败。
- **顺带把 `memoryIndex.*` 也 volatile 化**：本次无诉求，且注入面有「会话内字节稳定」的冻结语义，混在一起会模糊边界。落败。

## Consequences

- `review.dryRun` / `dailyBudget` / `batchSize` / `staleDays` 现在都能在 profile patch 里调，且热改在下一轮 drain 生效（有回归测试钉住）。
- 关 dry-run 从「改代码发版」降级为「改一行配置」，这是试运行收口的前置。
- 卡片内的设置区仍是待办（等参数形状稳定后再做），且届时只有卡片这一份 UI：官方 autoGenerate 表单路径不接，按「自带页面的插件」注册 `configure({ auto: false })`。
- 验证：337 测试（含「按轮重读设置」的热改回归）/ typecheck / lint / 覆盖率 96.14-89.74-100。
