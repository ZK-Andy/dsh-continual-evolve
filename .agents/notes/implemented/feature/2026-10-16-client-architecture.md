# Agent Note: 客户端纳入架构与上帝函数偿还

Status: implemented

> 放置路径：`.agents/notes/implemented/feature/2026-10-16-client-architecture.md`

## Problem

三笔旧债，一笔缺口：

1. `client/client.js` 四个组件全是上帝方法（`MemoryCard` 280、`WorkspaceBlock` 199、`WorkspaceScopeMenu` 155；`SettingsCard` 267 是本轮新续的，已先还到 66）。根因是手写 `createElement` 无 JSX 时图省事整坨写，且 hook 顺序测试让人不敢拆。
2. 组装根字面唯一性被挂载拆分打破：`card-mount.ts` 调用宿主 `inject/configure/edit`，而标准 §1 写的是 `index.ts` 唯一调用 host 注册 API；400 行预算和唯一性字面合起来无解（全塞回即 480 行超预算）。
3. `apply` 81 行，超 80 软预算 1 行（本轮 `readReviewSettings` 闭包引入）。
4. 标准缺口：§1 无委托条款；`client/` 在标准里零定义——无职责、无预算，门禁脚本只扫 `src/**/*.ts`。

## Decision

- 标准 §1 补委托条款：组装根可将挂载执行委托给 `surfaces/` 内聚挂载模块，但 Config 解包（`.get()`）与宿主形状声明保留在根，挂载模块只收普通函数、复用根的形状。
- 标准新增 `client/` 节：它是唯一的宿主侧渲染层，职责只有两条——请求时投影（记忆/技能）与全局设置表面；只经同源 fetch 调本插件路由，不直连 store，不引用宿主未声明服务；文案走 locale 注册，样式走 token + `dce-` 前缀单文件注入；保持单 bundle（host loader 约束，禁打包器）。预算：函数硬 80（上帝方法不允许），文件行数因单 bundle 豁免。
- 门禁脚本扩到 `client/*.js`：函数超 80 即硬失败（与 `src/` 的软警告不同）；`src/` 行为不变。
- 偿还手法统一为无 hook 纯函数抽取：hook 调用点原位不动（顺序测试不崩），行渲染/计算/校验下沉；`MemoryCard` 的 hook 测试下标因此全程有效。
- 悬崖记录不还：`store-types.ts` 400 整、`review.ts` 388 等近线文件只记录（新增走拆分），不动代码。

## Alternatives considered

- **client 拆多文件**：host loader 只认单 bundle id，多文件需引入拼接构建步，等于变相打包器，违背既有禁令。落败。
- **client 函数预算保持软警告**：与“上帝方法不允许”的拍板直接冲突，警告会被无视。落败。
- **挂载搬回 `index.ts` + ADR 豁免**：480 行换一张豁免条，比委托条款丑，且以后每次加挂载都要重新豁免。落败。
- **连 `MemoryCard` 旧债一起不动**：用户已明确“现在开始还”，只还新债说不过去。落败。
- **`apply` 软超 1 行不管**：软预算也是预算，且提取 helper 只有 11 行，顺手还零成本。落败。

## Consequences

- `SettingsCard` 66、`WorkspaceScopeMenu`、`WorkspaceBlock`、`MemoryCard` 全员 ≤80；`apply` 回 70 内；门禁双轨（`src/` 原样 + `client/` 函数硬门）全绿。
- hook 顺序测试零改动：抽取的 helper 全无 hooks，`makeHookReact` 下标体系 intact。
- 新增测试只锁纯逻辑（快照转换、脏检查、校验、选择解析、查询匹配），组件行为靠既有 hook 测试覆盖。
