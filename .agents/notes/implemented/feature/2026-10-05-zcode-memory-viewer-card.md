# Agent Note: 卡片对齐 ZCode 记忆选项卡 + 官方双语元数据（v0.14）

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

v0.13.0"市场同款"验收后用户仍拒收，四项内容/形态缺口：

1. **卡片名称与描述没有双语切换**：插件管理页显示包名 `dsh-continual-evolve`，语言切到英文也只是同一条；插件市场（dshmarket）的名称是中英文切换的显示名，不是包名。
2. **描述双语拼串**：v0.13.0 把 package.json `description` 写成"中文 / 英文"单条拼串。宿主把普通字符串原样渲染（不做翻译），于是两种语言都显示整串，还多出字面的 ` / ` 分隔符。
3. **卡片形态不是市场的收起/展开形**：没有展开收缩按钮，框样式（背景层、hover、展开态）也不对——正是 dshmarket 自己源码注释里承认并修掉的第一版错误（"自创的扁平、永远展开的盒子"）。
4. **卡片内容没对齐 ZCode 设置的记忆选项卡**（用户的原始对齐基准，此前未落字进任何 ADR）：ZCode 是"工作区选择 + 文件搜索 + 每文件相对更新时间 + 点击看内容"的查看器，我们的卡片是纯文本投影，无选择、无搜索、无时间、无内容预览。

根因一（1/2）：宿主读取插件显示元数据的正式通道是包根 `locale/<lang>.json`（`readPluginMeta`：以 `locale/en.json` 为锚点扫同目录语言文件，取 `meta.title`/`meta.description` 合成 `LocalizedText`，客户端 `resolveText` 按当前语言取一条；缺失才回退 package.json `name`/`description` 原文）。我们从未提供该通道。根因二（3/4）：v0.13.0 只抄了 token 与接线，没有抄结构和内容基准。

## Decision

一份改版、一次发版（0.14.0），三块：

- **官方双语元数据**：新增 `locale/en.json` + `locale/zh.json`（各含 `meta.title`/`meta.description`；en.json 必须存在，是宿主扫描的锚点）；package.json `exports` 增加 `"./locale/*.json"`、`files` 增加 `locale/*.json`；`description` 改回纯英文（npm 展示同一句）。名称（zh "工作区记忆" / en "Workspace Memory"）从此在插件管理页、内置插件列表双语切换。
- **卡片形态对齐市场**（`client/client.js` 重写）：默认收起的框卡 + 头部 `<button aria-expanded>`（名称 15px/600 + 一行说明 13px 三级灰 + 旋转 chevron，primitives 的 `IconChevronDownOutlineRegular`，缺则 `▾`），hover 与展开态走 dshmarket 同款 token（`bg-layer-3` 底、`label-dimmed` 边、展开换 `bg-layer-2`）。样式集中为一份注入 `<style>`（宿主自家 CSS-module 同机制，`document` 不存在时跳过），类名前缀 `dce-`，每个 token 带字面回退色。
- **卡片内容对齐 ZCode 记忆选项卡**：工作区 chips 选择器（LRU 上限 8，显示目录名不显示全路径）+ 文件搜索框 + 文件行（名称 + 相对更新时间：刚刚/N 分钟前/今天/昨天/Intl 日期，活动语言经 `localeTag` 字典键带出）+ 点击行展开内容预览（`<pre>`，max-height 滚动）。漂移警告（索引失联/未入索引）保留——这是 OBSERVATION 观察项的承载面，是 ZCode 查看器之外的刻意超集。

Host 侧（仍纯只读，只动两个文件）：`memory-snapshot.ts` 的文件条目增加 `updatedAt`（statSync mtimeMs），新增 `memoryFileContent(root, file)`——文件名必须是记忆目录内的纯 `.md` 条目（禁路径分隔符/穿越/basename 比对 + resolve 包含校验），超 `MEMORY_FILE_PREVIEW_LIMIT`（5 MiB，与 ZCode 预览上限一致）答 `too-large` 不读体，stat→read→stat 检出读期间变更以 `changed` 标记上报；`card-routes.ts` 挂第三条 GET-only 路由 `/api/v1/memory/file`，同一工作区白名单围栏，状态映射 400（越界）/404（不存在）/413（超大）。

## Alternatives considered

- **只补 locale 元数据、卡片维持 v0.13**：最小 diff，但形态与内容两项用户要求原样未动，下次还得返工。落败。
- **内容预览照抄 ZCode 桌面的双栏 master-detail**（左侧文件树右侧预览）：管理详情页容器窄，双栏挤；手写 bundle 里做树 + 选中态复杂度不成比例。落败——行内折叠预览信息密度相同，与卡片"收起/展开"语言还一致。
- **内容端点直接 `text/plain` 回文件体**：省 JSON，但客户端无法区分"已删除/超大/读期间变更"，三种状态都得猜。落败——JSON 体携带 `mtimeMs`/`changed`，状态映射到 404/413。
- **允许任意子路径读取（`file` 带目录）**：白名单只围工作区根，子路径放开等于给记忆目录开相对路径读取面；且库形态本就一层平铺（`listStoreFiles` 不递归）。落败——纯文件名 + basename/resolve 双校验。
- **不做预览大小上限**：记忆文件是模型写的 md，正常远小于 5 MiB，但无上限时一个异常文件就能把宿主内存拉爆。落败——5 MiB 与 ZCode 一致。
- **名称用 en.json 空 meta 走包名回退**（dshmarket 的做法）：en 显示 `dsh-continual-evolve` 技术名，与"显示名不是项目名"的要求相反。落败——en/zh 都给显式显示名。

## Consequences

买到的：插件管理页与内置插件列表的显示名/描述随 DSH 语言切换（不再是包名 + 拼串）；卡片有市场的收起/展开形态与主题状态；卡片内容与 ZCode 记忆选项卡同构（选择/搜索/更新时间/内容预览），并保留漂移观察。付出的：client bundle 约 425 行增至约 700 行（仍手写、无第二打包器）；API 面从两条路由扩到三条（围栏不变：GET-only、白名单、纯文件名）；发布包新增 `locale/` 目录与 exports 项——宿主 `readPluginMeta` 读不到时回退行为与 v0.13 一致，无破坏面。测试 66 → 80。

## Testing

vitest 1:1：`memory-snapshot.test.ts` 增 `updatedAt` 断言与 `memoryFileContent` 五例（正常含 mtime/索引文件可读/穿越与非法名拒/缺失/超大）；`card-routes.test.ts` 增内容路由五例（405/400、正常体、404 两态、400 穿越、413）；`client-card.test.ts` 断言 SettingsCard 形态与内容面源码级证据（样式注入、chevron、搜索、时间、预览、端点路径）、字典 `localeTag`、新增 `loadFileContent` 四态；并新增包级断言——exports/files 暴露 `locale/*.json`、description 无斜杠拼串、两个 locale 文件 `meta.title`/`description` 非空。

## Related

- `.agents/notes/implemented/feature/2026-10-05-market-parity-card.md`（v0.13：token/locale/Button 接线，本篇补齐其形态与内容缺口）
- `.agents/notes/implemented/feature/2026-10-04-plugin-management-card.md`（卡片能力起源与四条边界）
- 工作区 HANDOFF.md（dshmarket/ZCode 客户端源码调研能力来源）
