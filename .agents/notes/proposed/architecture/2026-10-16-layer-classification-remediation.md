# Agent Note: 归类纠正——层不变、类归位、门禁语义化

Status: proposed

> 放置路径：`.agents/notes/proposed/architecture/2026-10-16-layer-classification-remediation.md`
> class ∈ {feature, bug-fix, simplification, architecture, process, testing}
> 日期 = 首次提出日。

## Problem

动机：分层是对的（计划 §2：表现/应用服务/数据访问 + 通用仓储，`index.ts` 唯一组装根），分类是错的——实现期图省事，类被放到错的层，上帝类/上帝方法丛生。外部对标（NestJS `01-cats-app/src/cats/` 按模块收 controller/service/dto/interfaces；微软 eShop `OrderAggregate/` 内放 `IOrderRepository`、实现进 `Infrastructure/Repositories`）一致结论：类型跟模块走、接口定义在上层、组装根只做接线。

本轮实测证据（file:line 可查）：`data/review-accounts.ts:9` 值引 `services/memory-rules.js`（数据层依赖应用层，反向）；`src/surfaces/card-mount.ts` 把挂载（inject/configure/edit）放进表现层；`store-facets.ts` 按资源分接口撞 §7 否决项；根未分类地带（`review.ts:388`、`review-ring.ts:325`、`extraction.ts:299`、`extraction-ring.ts:369`、`llm-call.ts:354`、`chain/subagent*/token-usage/prompt-date/retention/import-md/plugin-log`）；`store.ts:34` 装配引表现层（`surfaces/skill-projection.js`，而卡片根本不用它——错层实锤）；`store.ts:90-96` 装配内联 SQL；`index.ts:179/210/249` 三套 mount 实现住在组装根（365 行）。

## Proposal

零豁免、零特权前提下的全量归位（每文件都有家，无残留）：

1. **组装根只剩接线**：`index.ts` 留 Config/形状声明/`apply` 一行调用 + 内联 config 读取闭包（读配置即组装本职）；全部 mount 搬走，完工约 200 行。
2. **卡片独立成页**：`src/pages/memory-card/`（`routes.ts` 卡+prompt 路由原样搬、`settings.ts` 原样搬、`mount.ts` 挂载持久 glue），单文件装不下 + 零豁免故拆小文件同目录；以后每个页面一个目录，同 pattern。
3. **通用装配单列**：`src/assemble.ts`（tools/extraction/review/creator-skills 四套 mount，约 260 行）；`card-mount.ts` 删除。
4. **根文件归位**：`review*/extraction*`（含 ring/candidates/surface）进 `services/`；`chain/subagent*/token-usage/prompt-date/retention/import-md/plugin-log/llm-call` 进 `services/`（传输算出站网关，不新设目录）；`review-prompt/extraction-prompt` 进 `services/`（环资产，§1“提示词文案”限缩为 section/指南）；`workspace-hint` 进 pages（卡片专用）。
5. **`skill-projection.ts` 拆散**：文件 IO 进 `services/skill-files.ts`（落盘语义）；`stateGet/stateSet/cursorGet` 下沉 `data/`（装配禁 SQL）；`secretLeakReason` 下沉 `data/secret.ts`（终结反向）。
6. **`store-facets.ts` 回滚**，`store-types.ts` 恢复单接口（绿的，本来无罪）；`records`/`Record` 平行体系保留（DB/API 分离）。
7. **`client/` 追认为表现层（宿主侧）**：职责两条（投影+设置），仅声明过的宿主模块 + 同源 fetch，函数硬 80；单 bundle 是平台约束（host loader 只认一个 id）。
8. **语义级门禁** `scripts/verify-layering.ts`（DSH 形状：tsx + FAIL 行 + exit 码 + 进 `run-gates`，合入前先红后绿验证）：R1 分层边逐文件显式校验（装配文件也是显式边，无概括特权）；R2 SQL/表名裸字符串只许 `data/*`；R3 `config.X?.y?.get(` 只许 `index.ts`；R4 禁新增根中央契约文件；R5 client 函数硬 80；既有行数/出度保留。

阶段：P0 facets 回滚 → P1 反向消除 → P2 大搬家 → P3 门禁接线 → P4 设置卡 A/B。每段独立提交、全绿、零行为变更。

待拍板：D0 本方案整体；D1 `llm-call` 进 services（建议，不新设目录）；D2 prompt 文案进 services + §1 微调（建议）；D3 单 bundle 平台约束表述（建议保留，备选多 bundle spike）；D4 设置卡 A 全删走自动 / B 保留认税（不建议，由用户定）；D5 records 平行保留（建议保留，合一是迁移级风险）；D6 神秘文件点名（如有）。

## Alternatives considered

- **按资源分接口（facets 现状）**：撞 §7“不做每资源一个接口”否决项，且与装配缝平行复制而非按域归属。落败：回滚。
- **mount 搬回 `index.ts` + 豁免**：用户已明确零豁免。落败。
- **新设 `src/infra/`、`src/mounts/` 等目录**：为两三个文件立新顶层目录，布局膨胀；现有目录经上述归位已够住。落败：除非审核要求。
- **上帝接口 + 调用点全量迁移（真 ISP）**：40 个调用点 churn，且方向与 §7 相悖（每资源接口本身就是否决项）。落败。
- **records/Record 合一**：DB 形与 API 形分离合法（entity vs DTO 同理），合一是迁移级风险。落败：保留。
- **设置卡维持双卡现状不决策**：700 行对应 5 输入框的税必须定价，不能悬置。落败：D4 二选一。

## Acceptance criteria

用户逐项批复 D0–D6（全过/改项重出）；批复后按 P0–P4 逐段动手，每段 tsc + oxlint + 491 测试（只增不减）+ 全门禁绿；纯搬家零行为变更；未批复前零落盘（本文件即唯一的落盘物）。

## Risks

- P2 import  churn 大，但全是机械搬家，编译器逐行验证 + 全量测试兜底。
- 单 bundle 平台约束若不被接受，回退到多 bundle spike（host 多 client 入口支持未知，需先验证）。
- records 平行体系保留意味着镜像观感仍在，已在 D5 明示，不算隐藏债。
