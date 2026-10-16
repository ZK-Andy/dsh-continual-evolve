# Agent Note: 归类纠正——层不变、类归位、门禁语义化

Status: implemented

## Problem

分层是对的（计划 §2：表现/应用服务/数据访问 + 通用仓储，`index.ts` 唯一组装根），分类是错的——实现期图省事，类被放到错的层。实测证据：`data/review-accounts.ts` 值引 `services/memory-rules.js`（数据层依赖应用层，反向）；`surfaces/card-mount.ts` 把挂载放进表现层；`store-facets.ts` 按资源分接口撞 §7 否决项；17 个根文件无家（`review.ts`、`review-ring.ts`、`extraction.ts`、`extraction-ring.ts`、`llm-call.ts`、`chain/subagent*/token-usage/prompt-date/retention/import-md/plugin-log`）；`store.ts` 装配引表现层（`surfaces/skill-projection.js`，而卡片根本不用它）且内联 SQL；`index.ts` 三套 mount 住在组装根（365 行）；`cwdOf`（应用关切）住在表现层、`services` 反向引 `surfaces`。

## Decision

用户逐项批复 D0–D6 后按 P0–P4 落地（每段独立提交、全绿、零行为变更），决议如下：

- **P0 存储表面归位**（`bc7ea42`）：`store-facets.ts` 删除，`store-types.ts` 恢复单 `MemoryStore` 接口（347 行）；`Memory/Skill/PromptRecord` 搬到 `data/records.ts` 与行形状同家（D5 合一的文件级形态——列级合一需改列名+迁移， defer 为后续迁移项，见 Consequences）。
- **P1 反向消除**（`9d4b7f1`）：`data/secret.ts` 拥有密钥筛查（`services/*` 与 `review-accounts` 向下依赖，`memory-rules` 只做重导出保测试路径）；`surfaces/skill-projection.ts` 搬 `services/skill-files.ts`（落盘语义，测试 1:1 跟随改名）；state/cursor 准备语句进 `data/ledger.ts`（`prepareStateStmts`，装配出度守 12）。
- **P2a 根文件归位**（`726c525`）：17 个根文件进 `services/`（D1：`llm-call` 不新设目录；D2：环自带 prompt 随环走，§1"提示词文案"限缩为 section/指南）。
- **P2b 组装根瘦身 + 成页**（`a43611e`）：`src/assemble.ts` 承载四套通用挂载（199 行），`index.ts` 留配置/形状/`apply`（365→230 行）；卡片六文件成 `src/pages/memory-card/`（D4=B：双卡保留，不删；`prompt-routes` 独立成文件——与卡路由合并超 400 行预算 2 行）。
- **P3 语义门禁**（`faba48d`）：`scripts/verify-layering.ts` 进 `run-gates` 与 pre-commit，R1 全文件显式边（含两装配文件）、R2 SQL 只许 `data/`、R3 `config.X?.y?.get(` 只许 `index.ts`、R4 根只留四文件，四规则逐条红绿验证；`cwdOf` 归位 `services/agent.ts`（消掉两条 services→surfaces 边）；评审环改吃根单例读器（消掉装配内第二份 volatile 闭包，D3 单 bundle 表述保留）。
- **P4**：D4=B 无代码动作；D6 无新增点名文件。

## Alternatives considered

- **按资源分接口（facets 现状）**：撞 §7"不做每资源一个接口"否决项，且与装配缝平行复制而非按域归属。落败：回滚。
- **mount 搬回 `index.ts` + 豁免**：用户已明确零豁免。落败。
- **新设 `src/infra/`、`src/mounts/` 等目录**：为两三个文件立新顶层目录，布局膨胀；现有目录经上述归位已够住。落败：除非审核要求。
- **上帝接口 + 调用点全量迁移（真 ISP）**：40 个调用点 churn，且方向与 §7 相悖（每资源接口本身就是否决项）。落败。
- **records 列级合一（改列名+迁移）**：snake_case 列与 camelCase API 二选一，无论哪边都是破坏性迁移（SQL 惯例 vs JS 惯例 + 全调用点/全测试），与本轮"纯搬家零行为变更"冲突。落败：先做文件级单一家，列级合一留待用户确认的迁移项。
- **卡+prompt 路由并一文件（提案原样）**：合并 402 行超预算 2 行。落败：保持两文件同页。
- **R3 豁免 assemble（保留第二份读闭包）**：门禁字面被破，且根已有同源单例读器。落败：环改吃根读器。
- **`cwdOf` 留表现层并在门禁里豁免两条边**：零豁免前提下无立足之地，且它是纯应用关切。落败：归位 `services/agent.ts`。
- **设置卡维持双卡现状不决策**：700 行对应 5 输入框的税必须定价，不能悬置。落败：D4=B 保留认税。

## Consequences

- 代价：6 个提交的 import churn（编译器逐行验证 + 491 测试兜底）；`verify-layering.ts` 的边表是显式清单——新增文件必须登记，否则红灯。
- 收益：`src/` 根只剩装配与形状四文件；`services→surfaces` 反向清零；volatile 解包唯一家（根单例读器）；SQL 只许 `data/` 由机器保证。
- 后续：records 列级合一（改列名+数据迁移+版本号）待用户另行拍板，默认不做；`client/` 表现层地位与单 bundle 约束已在架构标准 §1 落字（D3）。
