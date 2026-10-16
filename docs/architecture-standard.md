# TS 架构规范

> 适用 `src/` 全部模块与 `client/`（经典分层：`store.ts`（存储装配）/ `index.ts`（插件组装根）/ `assemble.ts`（通用挂载装配）/ `pages/`（整页：一个页面一个目录）/ `surfaces/`（工具、注入、快照、section 文案与指南）/ `services/`（应用服务：写门禁规则与批量应用、提取/评审环、传输、子代理）/ `data/`（连接、通用仓储、迁移、账本、巡检、密钥筛查）/ `client/`（唯一的宿主侧渲染层：请求时投影与全局设置表面），`test/` 镜像被测文件归属）。见 ADR `2026-10-06-sqlite-single-store` 与 `2026-10-04-zcode-alignment-teardown`。

## 1. 组装根与分层归属

- `index.ts` 是唯一组装根：唯一读 Config 做解包（volatile `.get()` 不出根）、唯一声明 `inject` 与宿主 API 形状（不 import DSH 类型包）；挂载执行委托通用装配（`assemble.ts`：工具/提取/评审/自带技能）与页面挂载（`pages/*/mount.ts`），被委托方只收普通函数、复用根声明的形状，不得自建第二份、不读 Config。400 行预算与本条打架时优先拆分，不豁免回根。
- 存储装配在 `store.ts`（表面是 `store-types.ts` 单接口，行/记录形状单一家在 `data/records.ts`）；统一读写工具在 `surfaces/evolve-tools.ts`；提取/评审轨与传输、子代理在 `services/`（环自带提示词是环资产，随环走；`§1` 的"提示词文案"仅指 section 渲染与指南）；卡片整页在 `pages/memory-card/`。
- 宿主侧渲染只在 `client/`：职责两条——请求时投影（记忆/技能/提示词）与全局设置表面；只经同源 fetch 调本插件路由，不直连 store，不引用宿主未声明服务；文案走 `locale.register` + `bind`，样式走 `var(--dsw-alias-*)` token + `dce-` 前缀、单文件一次注入，primitives 缺席时原生兜底；保持单 bundle（host loader 只认一个 bundle id，禁打包器、禁构建拼接）。
- 一个 system-prompt section 一个注册点；section 名与 order 集中管理。

## 2. 模块规模预算

| 预算 | 上限 |
|---|---|
| 单文件行数（`src/`） | ≤ 400 |
| 单文件出度（import 的内部模块数） | ≤ 12；组装根 `index.ts` ≤ 14 |
| 单函数行数（`src/`，软） | ≤ 80（超了只警告） |
| 单函数行数（`client/`，硬） | ≤ 80（上帝方法不允许，超了门禁失败；文件行数因单 bundle 豁免） |

超限必须在重构计划内拆分或携带 ADR 豁免；新增文件直接按预算卡。`client/` 无 import、无出度，出度规则不适用。

## 3. 退役规则

1. 一条路径被取代，同一版本内必须三选一：删除；降级到 `legacy/` 命名空间并停止接线；或改造成新路径的组成部分。禁止"新路径上线、旧路径保持全量接线"跨版本共存。
2. 每个配置键必须映射到一条活路径；路径断开后其专属配置键同版本删除，README 配置表同步。
3. feature 开关默认关闭超过两个版本且无使用证据 → 进入删除裁决。

## 4. 不变量（任何重构永不妥协）

1. 注入永不破坏会话组装：查库/bootstrap 的任何失败都降级为空渲染，不抛进宿主；`node:sqlite` 不可用时插件整体降级为无操作 + 告警。
2. prompt section 会话内字节稳定（prompt cache 契约）。
3. **存储单写者**：插件代码是记忆库的字面唯一写者——模型意图（显式与自动）一律经结构化提案过机械门禁（约束/枚举/secret/去重）后由代码事务内落盘；任何"模型直写存储"的路径都违宪。后台提取（定时器/监听器/LLM 调用）是唯一获准的常驻自动化，其护栏：轮级触发 + 去抖合并、机械跳过记账、全程 `extraction_log` 可对账（ADR `2026-10-06-sqlite-single-store`）。
