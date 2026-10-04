# Agent Note: 市场同款记忆卡片（含双语跟随）

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

v0.12.1 只读记忆卡片在 dotnet-desktop 验证中功能通（卡片出现、注入正常），但用户拒收样式：裸 `div/ul/button`、无主题、无语言跟随，与插件市场同款完全不对仗。另有两个实锤缺陷：文件行用 `createElement(...) + 字符串` 拼出 `[object Object]`；包头描述是纯英文（宿主读 `package.json description` 渲染，卡片管不到）。

## Decision

按 dshmarket 实证（2026-10-05 安装包核对）重做 `client/client.js`：

- `exports.inject` 从 `["slots"]` 扩到 `["slots","locale","theme"]`；`package.json dsh.client.inject` 补齐市场三件套（locale / ui-settings / ui-theme），`description` 改中英双语。
- client 工厂内 `require("react")` 不变，新增可选 `require("@deepseek-ai/dsh-client-ui-primitives")`；`ctx.locale.register(NS,{zh,en})` + `t = ctx.locale.bind(NS)`，缺 locale 时回落中文硬串。
- 全部卡片文案进 `zh/en` 字典（含空态、漂移警告、读取失败前缀），跟随 DSH 语言选择；技术错误码保留语言中立的 `HTTP xxx` 形。
- 样式走 `var(--dsw-alias-*)` 主题 token（卡片底、边框、圆角 12px、二级文字色），有 primitives 时刷新按钮用 `Button`（`variant: outline, size: sm`），缺 primitives 时降级为同 token 的裸 `button`——老宿主不白屏。
- 修 `[object Object]`：文件行改 `createElement("li", ..., createElement("strong", ...), " — description")` children 传参。
- host 侧（`src/` API、白名单围栏）不动；只动 client + 包元数据 + 测试。

## Alternatives considered

- **只修 bug + 硬编码中文**：最小，但仍是裸 div，与"市场同款"的用户要求差一代，下次还得返工。落败。
- **照搬 market 全套组件（含 Modal/Toast/设置页框架）**：market 的 client 是 rolldown 产物 14k 行，含安装/分组/主题画廊等与记忆卡片无关的机器；抄全套违背"禁第二打包器"且体积爆炸。落败，只取 locale/theme/primitives 接线与 token 风格。
- **不做降级、强依赖新宿主**：老宿主（无 slot/无 primitives）会白屏整个设置对话框（dshmarket #671 形状）。落败，保留 slot 自探测 + primitives 缺失降级，核心 section 注入不受影响。

## Consequences

买到的：卡片与市场同款视觉（主题 token + `Button` 刷新），中英文案跟随 DSH 语言，`[object Object]` 根除。付出的：client bundle 增至约 425 行手写 JS（仍无打包器），`dsh.client.inject` 新增三项宿主 client 模块声明——老宿主缺这些模块时走降级路径，卡片仍渲染为同主题裸元素。`plugins.bundle.config` 槽位形状仍是反向工程所得，上游若改，卡片静默消失而注入不受影响。

## Testing

vitest 1:1：`client-card.test.ts` 从 7 例增至 11 例——inject 三件套、slot 注册含 `locale`、有/无 locale 下字典注册与回落、有 primitives 时 `Button` 接线、无 primitives 降级渲染、源码级断言（zh/en 字典、主题 token、`Button` 引用、无 `createElement("strong"..)+` 形状）。66 测试全绿；`tsc` 双工程、`oxlint`、`run-gates` 全绿。

## Related

- `.agents/notes/implemented/feature/2026-10-04-plugin-management-card.md`（被本篇超集的前代：裸 div 实现）
- 工作区 HANDOFF.md（dshmarket 源码调研能力来源）
