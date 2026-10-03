# TS 架构规范

> 适用 `src/` 全部模块；`test/` 无分层约束但镜像被测文件归属。
> **文件→层映射的唯一事实源是 [`scripts/verify-architecture.ts`](../scripts/verify-architecture.ts) 的 `LAYER` 表**（机器校验）；本文只定义层语义与规则。违标白名单也在该脚本内，每条注明清偿 Phase。

## 1. 五层模型

依赖只允许**向下**（L_n → L_{n-1} 或更深）；同层允许互相依赖但**禁止成环**；任何层禁止依赖上层。

| 层 | 语义 | 允许的 IO | 禁止 |
|---|---|---|---|
| **L0 类型与常量** | 跨层共享的类型、静态文本、workspace 身份 | 无 | 任何内部依赖（`node:*` 内置除外） |
| **L1 纯引擎核心** | 状态与验证闭环（原子写/校验/应用/回滚/快照/历史）与纯领域逻辑（检索排序、晋升政策、投影、合并、计分） | 本地文件（store/投影/审计） | `@deepseek-ai/*`、`ctx.*`、LLM、网络 |
| **L2 host 适配层** | **唯一**触碰 cordis / DSH host API 的层：LLM 直调边界、prompt section、审批弹窗、技能落盘、热挂载、日志、token 记账、轨迹读取、语言链 | `ctx.*`、host API、LLM | — |
| **L3 领域流程** | 一个"进化时刻"的编排（memory agent、门禁调用、planner、wrapup、benchmark 执行） | 只经 L2 适配模块间接使用 host 能力 | 直接持有 `Context`（经参数注入） |
| **L4 接口面** | 模型工具、人类命令、事件监听器、组装根 | 组装 L1–L3，注册进 host | 实现领域逻辑（只做路由与组装） |

## 2. host API 单点边界（机器校验）

| host 能力 | 唯一/允许入口 |
|---|---|
| `ctx.llm` | `llm-text.ts`（直调与工具 loop 唯一边界）；`planner.ts` / `skillquality.ts` 仅作引用传递，Phase 2/3 收敛 |
| `ctx.systemPrompt` | `index.ts`（注册）；section 渲染逻辑在 `inject.ts` / `memory-index.ts` |
| `userQuestions` | 询问行为只在 `approval.ts`；其余文件仅 inject 声明与透传（`index` / `auto` / `wrapup-command`） |
| `ctx.tools` | `tool.ts`；`mount.ts` 裸 register 例外（FAQ #2） |
| `ctx.commands` | `command.ts` |
| `sessionQuery` / 轨迹读取 | `turn-snapshot.ts` + `message-source.ts` |
| `ctx.subagents` | 禁止直调——评估走 `evaluate.ts` 的注入执行器 |

L3 需要以上能力时，一律通过 L2 模块的函数签名注入；L0/L1 出现任何 `@deepseek-ai/*` import 即违规。

## 3. 组装根唯一性

- `index.ts` 是唯一组装根：唯一读 Config、唯一调用 `ctx.provide/section/register*`。
- listener、命令路由、工具注册所需依赖（engine、gate、policy、LLM 边界）由 `index.ts` 注入，禁止自行重建 store/engine 访问。
- 一个 system-prompt section 一个注册点；section 名与 order 集中在 `index.ts`。
- L4 访问引擎状态一律经 `service.ts` facade；直接 import `state`/`store` 属 facade 绕过（机器校验项）。

## 4. 模块规模预算

| 预算 | 上限 |
|---|---|
| 单文件行数 | ≤ 400 |
| 单文件出度（import 的内部模块数） | ≤ 12；组装根 `index.ts` ≤ 14 |
| 单函数行数（软） | ≤ 80 |

超限必须在重构计划内拆分或携带 ADR 豁免；新增文件直接按预算卡。

## 5. 时代残留退役规则

1. 一条路径被取代，同一版本内必须三选一：删除；降级到 `legacy/` 命名空间并停止接线；或改造成新路径的组成部分。禁止"新路径上线、旧路径保持全量接线"跨版本共存。
2. 每个配置键必须映射到一条活路径；路径断开后其专属配置键同版本删除，README 配置表同步。
3. feature 开关默认关闭超过两个版本且无使用证据 → 进入删除裁决（复用命令面复测的测量方法论）。
4. 新能力默认进对话与模型工具；接口面（L4）只在"人类必须在场"时扩张（zcode-parity-boundary ADR 判据）。
5. 任何常驻后台自动化必须用 token 账与产出账证明 ROI，每次大转向时年审一次。

## 6. 机器门禁

`scripts/verify-architecture.ts`（接入 `run-gates`）校验：层方向与禁环（SCC）、host-API 单点边界、L0/L1 包纯度、facade 绕过、规模预算。文件移动层 = 改 `LAYER` 表 + 改代码同一提交；白名单条目必须在清偿 Phase 删除。

## 7. 不变量（任何重构永不妥协）

1. store 磁盘格式与 schema version 兼容——存量 local/project/global 数据零迁移加载。
2. 审计语义：失败不推进 cursor、不静默重试、必留 `reviews.jsonl` 记录。
3. 快照先于写入；回滚是确定性逆操作。
4. prompt section 会话内字节稳定（prompt cache 契约）。
