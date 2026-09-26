# Agent Note: 确认弹窗文案刷新（headline→要点→影响 + description）

Status: implemented

## Problem

四个 `userQuestions.ask` 确认弹窗（global/project 写入、fate 归宿、wrapup 单条归档、技能固化）共用一个丑因：问题文本是 `\n\n` 大段 blob，`options` 只有光秃 label、无 `description`。DSH 上游 09-24 的 `652bc9d` 只对齐了圆角 token 与品牌蓝 focus 环，救不了文案层。用户在真机预览中确认“看着好一点”的方向后，拍板按新文案执行。

## Decision

- 文案统一为 headline → 要点 → 影响三段式（借 `nexu-io/open-design` 的 `DESIGN.md` voice 规则与 `web-prototype-taste-editorial` 的字面标签约束；只借规范，不装 App、不改 DSH 壳）。
- `src/approval.ts`：首行改为 `写入${storeLabel}？`，中段透传 `what`（超 300 字截断加 `…`），末行加影响句（global：所有会话可见 / project：仅本项目会话可见，均可回滚）；`options` 补 `description`，label `批准/拒绝` 不动。
- `src/fate.ts`：`consultQuestion` 首行改为 `自进化门禁：本会话 local 条目需要归宿处理`，分组标题改为 `【提升到全局（写入全局 store）】` / `【归档（本地隐藏，可恢复）】`，末行补后果句；`options` 补 `description`（执行：均可恢复 / 不执行：10 回合冷却），label `执行/不执行` 不动。
- `src/wrapup-command.ts`：单条归档改为两行 headline（`wrapup 确认归档：条目「…」` + 来源/后果行）；`options` 补 `description`，label `归档/保留` 不动。
- `src/auto.ts`：技能征询首行改为 `发现可复用的流程，建议固化为技能`，末行补可回滚句；`options` 补 `description`，label `固化/不固化` 不动。
- 解析逻辑（按 label 字面匹配）零改动；`questionId` 零改动。
- 测试：新增 `test/confirm-copy.test.ts` 5 例，断言每处首行 headline、影响/后果句、label 不变、`description` 存在（含 project 截断臂）。

## Alternatives considered

- **等 DSH 出全新确认弹窗样式**：上游近期只有 token 对齐小修，无重设计排期；文案丑在我们侧，等壳解决不了，拒绝。
- **全量装 OpenDesign App（`open-design` profile + `dsh-runtime`）**：为改四个文案引入 Node 24/pnpm/Docker 整套，重量与收益不成比，拒绝。只单文件取 `DESIGN.md`/taste 规范。
- **改 label 文案（如“批准”→“写入全局”）**：三处解析按字面匹配，改 label 即改契约且要动全部 mock；`description` 已够表达，拒绝。label 冻结。
- **把 `what` 全文展开不截断**：超长标题/内容会把弹窗撑爆，拒绝。300 字截断加 `…`，详情仍在审计日志可查。

## Consequences

- 四处弹窗首屏可扫读：目标 store、影响范围、可恢复性、冷却期都在按钮旁可见；拒绝/关闭行为与之前一致（缺席/歧义照旧抛错或保守拒绝）。
- `requestScopeApproval` 新增 300 字截断常量（内联，未进配置：纯展示约束，非可调产品参数）。
- 真机已用预览文案走过一轮四连弹（用户全部拒绝/关闭，无任何写入），文案与实机一致。
