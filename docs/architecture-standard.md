# TS 架构规范

> 适用 `src/` 全部模块（2026-10-04 终极收敛后为三个文件：`index.ts` / `memory-section.ts` / `memory-guide.ts`）；`test/` 镜像被测文件归属。历史五层模型与机器门禁随机制拆除，见 ADR `2026-10-04-zcode-alignment-teardown`。

## 1. 组装根唯一性

- `index.ts` 是唯一组装根：唯一读 Config、唯一调用 host 注册 API、唯一声明 `inject`。
- 宿主 API 形状在 `index.ts` 本地声明（不 import DSH 类型包）；section 渲染与文件操作在 `memory-section.ts`；提示词文案在 `memory-guide.ts`。
- 一个 system-prompt section 一个注册点；section 名与 order 集中管理。

## 2. 模块规模预算

| 预算 | 上限 |
|---|---|
| 单文件行数 | ≤ 400 |
| 单文件出度（import 的内部模块数） | ≤ 12；组装根 `index.ts` ≤ 14 |
| 单函数行数（软） | ≤ 80 |

超限必须在重构计划内拆分或携带 ADR 豁免；新增文件直接按预算卡。

## 3. 退役规则

1. 一条路径被取代，同一版本内必须三选一：删除；降级到 `legacy/` 命名空间并停止接线；或改造成新路径的组成部分。禁止"新路径上线、旧路径保持全量接线"跨版本共存。
2. 每个配置键必须映射到一条活路径；路径断开后其专属配置键同版本删除，README 配置表同步。
3. feature 开关默认关闭超过两个版本且无使用证据 → 进入删除裁决。

## 4. 不变量（任何重构永不妥协）

1. 注入永不破坏会话组装：store 读取/ bootstrap 的任何失败都降级为空渲染，不抛进宿主。
2. prompt section 会话内字节稳定（prompt cache 契约）。
3. 插件保持零后台自动化：不开 LLM 调用、不装监听器、不起定时器——任何"常驻自动化"提案先过 ROI 证明。
