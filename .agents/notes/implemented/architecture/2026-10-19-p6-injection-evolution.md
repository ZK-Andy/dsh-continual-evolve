# Agent Note: P6 注入演进与 seeded-store 全量集成测试

Status: implemented

> 上游输入：总纲 `docs/plans/2026-10-19-architecture-supplement-plan.md` §2 D3/D11 + §3 P6、PilotDeck 差距分析 `docs/research/pilotdeck-gap-analysis.md` §3.3/§5.1-4。
> 落地提交：P6 批（`src/surfaces/memory-section.ts` 分层 + `invalidate`、`src/index.ts` 压缩订阅、`test/eval-seeded-store.test.ts`、`test/memory-section.test.ts` 同改、三基线重定）。

## Problem

注入是行级平铺（`memory-section.ts:buildSection` 把 `store.list` 的 feedback > user > reference 顺序铺成 `<memories>` 单块），无分层标题、无冲突守则——长索引里人物画像、项目事实、经验反馈混在一起，模型没有"谁优先"的明示规则。post-compact 重注入未验证：宿主是否给压缩钩子、冻结 section 在压缩后是否重建，两者都没结论。D3 决策门（每轮检索 vs 会话冻结）缺实测数据支撑。另外 runner 测试跑的是空库：`test/eval-runner.test.ts` 的 `testStore()` 从不播种，recall 全 false 是空断言——runner↔store↔检索的接线在零网络下从未被测透。

## Decision

三件同批落地（P6 + seeded-store 集成补丁含本批，方案 B）：

**1. 注入分层（构建期内容，冻结与字节稳定契约不变）。** `buildSection` 在现有 `MEMORIES_ORDER` 之上按映射表分组渲染，非空组才出标题（空组省略，不占预算——同 store 同预算输出恒定）：

| 新分层 | 来源（`type × 分区`，`workspace_id=""` 为全局 L0） | 说明 |
|---|---|---|
| User Profile | `type=user`（全局 + 项目） | 人物/环境画像 |
| Project Meta | `type=reference` 且全局分区 | 跨项目可复用的项目事实 |
| Project Memory | `type=reference` 且项目分区 | 本项目绑定的事实与机制 |
| Feedback Memory | `type=feedback`（全局 + 项目） | 经验纠偏 |

映射读 `record.workspaceId`（分区），不读行 `scope` 列（`person` 遗留值与 `project`/`global` 迁移 CHECK 并存，以分区为准）。组内保持 `store.list` 顺序，不另排序；四组按上表固定先后渲染。`<memories>` 块内追加冲突守则一行（`INJECTION_CONFLICT_RULE`："与本轮指令冲突以本轮为准"）。`guide=false` 同样分层；空库与超预算零容纳分支语义不变。标题与守则行不占行预算，但计入上报 token（`estTokens = fit.tokens + 标题守则估算`），账本不撒谎。

**2. post-compact 重注入（最小接线，已落地）。** 核实结论：宿主确有 `session/event` + `compaction/start` 事件（`services/extraction.ts:173-180` 已在监听），hook 存在——"无 hook 即归档"条件未触发。`FrozenMemorySection` 新增 `invalidate(sessionId)`（删单键）；装配点选 `src/index.ts`（`assemble.ts` 只管 mounts，renderer 的 freeze 归组装根管，且 `index.ts` 出度/行数仍合预算：326 行、无新增运行时 import，只加一个 type import）：`apply` 内建 freeze 具名实例并在同一 `session/event` 上订阅 `compaction/start` 单键失效——压缩后该会话下一次 assembly 重建（含压缩前刚落盘的新记忆），其他会话缓存不动。订阅失败吞掉不抛（注入永不破坏组装）。

**3. D3 决策门保持 open。** 首跑推迟到全项目完成后（用户拍板），本批只定判定口径：recall@1 < 90% 且 p95 注入 token < 2000 则维持冻结，否则重议。

**4. seeded-store 全量集成测试（`test/eval-seeded-store.test.ts`）。** test 层自包含（不进 `src/`，不触发 G12/R1）：从 `evals/tasks/*.json` 原始 JSON 收集 12 种子（收集逻辑 test 内 30 行，不反向依赖 `scripts/`），经真实写门禁播种空库（断言零拒绝）；`injectionFor` 非 base 臂复用生产 `buildSection` 真实渲染（与 `assemble.ts:171-182` 同一函数）；脚本化模型零网络——按 prompt 精确匹配任务，回 needles + 该任务种子 body 全文 + 注入文本前 500 字符，`usage` 照常记账；`runEvalBatch` 22 任务全批 `repeat:1` 跑四臂。断言：seed 12 零拒绝；四臂 acc ≥20/22；recall_hit ≥11/18（与 `eval:recall` 实测 73.3% 同分布）；task-001 回复含 body 片段"CI 未绿"（种子耦合）与"## "标题（注入耦合）。

## Alternatives considered

- **分层按 scope 先切 global/project 再按 type 切（八组）**：组数翻倍，空组多，小库全是标题噪声；且现有 `MEMORIES_ORDER` 是 type 主键，scope 主键要改 SQL 排序，动存储面。落败：type 主键四组，非空才渲染。
- **分层信息放每行标签而非组标题（如 `- [id] (user|U) title`）**：行级标签省结构但模型仍需自己归纳"谁优先"，PilotDeck 要的是组级先验 + 冲突守则。落败：组标题 + 守则两行，成本同为提示词两行。
- **post-compact 直接订阅重建全量 section（清整个 frozen map）**：影响同进程其他会话的 prompt cache。落败：按 `compaction/start` 的 session id 单键 `invalidate`，影响面最小。
- **post-compact 因"桌面端能力未验证"直接归档**：hook 存在性在 web/desktop 间无差异（`session/event` 是 extraction 已依赖的既有事件，非 workflowEngine 专属）。落败：hook 已证存在，做最小单键失效。
- **seeded 测试复用 `scripts/eval-recall.ts` 的收集逻辑（import 或抽 `src/services/eval-seed.ts` 新模块）**：`scripts/` 不进 npm 包、`src/` 不能依赖它；抽新模块要登记 R1 边、配 G9 对子测试、过预算，为 30 行收集逻辑不值。落败：收集逻辑 test 内自包含，与 `eval-recall.ts` 保持"共享 fixture 而非共享代码"纪律。
- **脚本化模型直接回 kitchen-sink 常量**：回吐与种子无关，注入断了也照过。落败：needles + 种子 body + 注入摘录三合一回吐，另加 body 片段与标题断言做耦合。
- **D3 本批直接拍板维持冻结**：数据还没出，无据拍板。落败：口径定死、门保持 open，首跑后一轮过。

## Consequences

- 买到的：注入有组级先验 + 冲突守则；压缩后记忆接回上下文（含压缩前刚落盘的新记忆）；runner↔store↔检索接线在零网络下被 12 种子 + 22 任务全批钉住（recall 纯检索度量，不可 cheat；acc + 双耦合断言钉 plumbing）。
- 付出的：`memory-section.ts` 320→386 行、`index.ts` 301→327 行（预算棘轮/API 快照/函数形状三基线同批重定，有 ADR 即依据）；标题行在极端小预算下占比相对变大（零容纳分支语义不变）。
- D3 门 open：首跑（全项目完成后，需用户触发）出 recall_hit/acc/cost 三数后一轮过。

## Testing

- `test/memory-section.test.ts` 21/21：两处旧形状断言按新分层改写（预期内红随批同改），新增 `layerOf` 映射、`Project Meta` 全局优先、`invalidate` 单键失效三组。
- `test/eval-seeded-store.test.ts` 1/1：12 种子零拒绝、四臂 88 行 `eval_cases`、warnings 为空、无 flaky。
- 全量：952 测试绿、`tsc`/`oxlint` 干净、`run-gates`（默认 + docs）全绿。
