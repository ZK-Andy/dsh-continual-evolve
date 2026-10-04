# Agent Note: 官方插件管理内置只读记忆卡片

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

插件的核心资产——`<工作区>/.evolve/memory/` 记忆库——对用户完全不可见：模型在会话里读写，用户想看只能手动开文件。v0.12.0 拆掉全部机制后，连"沉淀质量 / 索引漂移率"这两个已立项观察项（工作区 OBSERVATION.md）都没有承载面。同时调研证实（dshmarket 源码，2026-10-04 安装包核对）：DSH 宿主在官方插件管理页为第三方 bundle 开了 UI 槽位（`plugins.bundle.config` 等 client slot），市场插件已用同一机制把自己挂进官方界面——能力存在，本插件此前没用。

## Decision

插件新增**只读记忆卡片**：在官方插件管理的本 bundle 页面渲染 `.evolve/memory/` 的只读投影。四条边界：

1. **单一事实源**：卡片是磁盘文件的请求时纯投影（`src/memory-snapshot.ts`），无编辑路径、无缓存、无自持状态；卡片与文件不一致的唯一合法原因是文件刚被改过——刷新即消失。
2. **零写路径**：host 侧只读文件；已知工作区清单（`src/known-workspaces.ts`）是进程内存中的有界 LRU（section 注入时记下 cwd），不落盘、不持久化——重启即空，开一次会话即回。
3. **槽位自探测、老宿主优雅降级**：client bundle 只经 `ctx.slots.inject('plugins.bundle.config', …)` 挂载（宿主没声明该 slot 则从不执行）；host 侧路由经嵌套 `inject(['webServer'], …)` 挂载（无该服务的宿主不挂路由）；client bundle 不依赖任何宿主 UI primitives（纯 React DOM），primitive 缺失问题不存在。核心 section 注入在任何降级路径下不受影响。
4. **安全围栏**：API 只读、GET-only；`memory?root=` 参数只接受进程内记录过的已知工作区根（白名单），不提供任意路径读取。

接线事实（dshmarket 实证）：host 路由走 `webServer.register({kind:'exact', path, handler})`，路径前缀 `/dsh-continual-evolve/api/v1/`；client bundle 是手写 `window.__ModuleLoader__.load({id, factory})` 工厂（factory 内 `require('react')` 从宿主模块表解析，结尾 `return module.exports`），package.json 以 `dsh.client = { inject: [], platform: 'web' }` + exports `"./client"` 声明。新配置键 `memoryCard.enabled`（默认 true）。

## Alternatives considered

- **不做卡片，维持纯注入形态**：最保守，但观察项没有承载面、用户对记忆库零可见性；且 dshmarket 已证明槽位机制稳定，"可见性"本身是长期维护立场的合理诉求。落败。
- **卡片带写路径（UI 内批准晋升/编辑记忆）**：被否——v0.12.0 收敛明确"记忆不得自动进 git 跟踪文件、展示层不产生第二事实源"；UI 写路径等于长回刚拆掉的治理机制。落败，卡片严格只读。
- **用 tsdown 构建 client bundle**（dshmarket 同款）：`docs/coding-standard.md` 红线"禁引入第二构建器/打包器"；且为此引入 react/tsdown 开发依赖违背最小增量。落败——bundle 极小（无 TSX、无 primitives），手写工厂并配 vitest 工厂级测试。
- **持久化"最近工作区"清单到 profile 目录**（dshmarket 的 `.dsh-market/` 状态模式）：为卡片引入第二个磁盘状态，违背"文件就是 store"；进程内存 LRU 已覆盖真实场景（用户重启后开一次会话即恢复）。落败。
- **注册全部三个座位**（`settings.plugin.item` / `settings.plugins.tab` / `plugins.bundle.config`，dshmarket 为跨宿主版本线三线并挂）：兼容机器是 dshmarket 源码里最大的一块；本插件只需 0.1.7+ 的 bundle 页座位，slot 自探测已保证老宿主静默降级。落败，只挂 `plugins.bundle.config` 一个座位。

## Consequences

买到的：观察项（沉淀质量、索引漂移率）有了可见承载面；用户不开文件就能看到记忆库规模、索引条目与漂移警告（未索引文件 / 索引失联文件）。付出的：src 从 3 文件增至 6 文件、发布包新增 `client/`（手写 bundle）；`plugins.bundle.config` 的宿主契约是反向工程所得（dshmarket 源码注释），上游若改 slot 形状，卡片静默消失而核心注入不受影响——这是接受的降级方向。client bundle 内用了一次 `console.warn`（react 解析失败时），因浏览器侧在任何 logger exporter 之前、无其他出口，属于 host 侧"禁 console.*"红线的已声明例外。

## Testing

vitest 1:1：`memory-snapshot.test.ts`（完整库/漂移/缺目录/坏 frontmatter）、`known-workspaces.test.ts`（LRU 界限、最近序）、`card-routes.test.ts`（GET/405/400/404 白名单/JSON 形状）、`client-card.test.ts`（工厂加载、exports 形状、slot 注册、summary 视图返 null、模型装配）。

## Related

- 工作区 HANDOFF.md（能力来源：dshmarket 源码调研，2026-10-04）
- OBSERVATION.md（观察项：`.evolve/memory/` 沉淀质量与索引漂移率——卡片是其承载面）
