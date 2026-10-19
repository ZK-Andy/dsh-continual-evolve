# Agent Note: freshness 门兼容 runner 的 markdown 列表 commit 行

Status: implemented

Review: FULL/2026-10-20#2/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

2026-10-20 首跑回填时，`evolve_eval_run` 返回的 `compare.md` 按 `renderCompare` 的 markdown 列表形状写 `- commit: <sha>`，而 `verify-eval-freshness` 的 `parseCompareHeader` 正则只认裸 `commit:` 行（测试与 fixture 也全是裸格式）。P5b 跑批第一次真实产出就暴露了这处生产/消费错位：`evals/runs/2026-10-19/compare.md` 已落盘且 commit 覆盖 HEAD，gate 仍报 stale。错位在 P5b 内无测试钉住——`eval-gates.test.ts` 只覆盖裸格式，从未用 runner 真实输出做过解析断言。

## Decision

`parseCompareHeader` 的正则接受可选的 markdown 列表前缀 `- `：`/^(?:-\s+)?commit:\s*([0-9a-f]{7,40})\s*$/`，裸格式继续有效（fixture 与旧 compare 不受影响）。`renderCompare` 不动——runner 输出是已发布的产物形状，改消费侧是单点收敛。`test/eval-gates.test.ts` 新增"首跑回填形状"用例，直接用 `renderCompare` 风格的完整头做解析断言。

## Alternatives considered

- **改 `renderCompare` 输出裸 `commit:` 行**：产物形状是已发布约定（首跑输出与文档示例均按列表形状），改生产侧要同步所有消费者；且 fixture 证明裸格式本就该被支持，双向兼容比单向改写便宜。落败。
- **回填时手工加一行裸 `commit:` 绕过正则**：产物与 runner 输出不一致，后人复现跑批会对"哪一行才是真的"产生疑问；用一次性手工绕过掩盖门禁缺陷，违反彻底解法立场。落败。
- **本轮只提交数据、错位挂账**：freshness 门在下个带三面改动的发版前读不到这次 compare，回填"数据作为下版 gate 输入"的目的落空。落败。

## Consequences

下个发版窗口的 freshness 门能读到 markdown 列表形状的 compare；裸格式的旧 fixture 与测试继续全绿。代价：正则放宽一行——头 10 行约束不变，误命中面限于头 10 行内带 `- ` 前缀的 commit 行（此前裸 `commit:` 散句本就可命中，类别未变，只是前缀多一种）。

## Testing

`test/eval-gates.test.ts` 新增 markdown 列表头解析用例；`./node_modules/.bin/vitest run test/eval-gates.test.ts` 全绿；`scripts/verify-eval-freshness.ts --changed src/data/records.ts --head <HEAD>` 对回填后的 compare 报 fresh。

## Related

- [P5a 评测基建](../testing/2026-10-19-p5a-eval-infra.md)：freshness 门的上游家（发版门定义与 compare 携带 commit 的约定）。
- [P5b 跑批与 runner](../testing/2026-10-19-p5b-eval-runner.md)：生产/消费约定的上游家（`renderCompare` 定 `- commit:` 形状）；本 note 仅修复二者接口错位，无 supersession。
