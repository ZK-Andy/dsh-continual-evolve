# Agent Note: evals/runs 机器回填数据豁免 behavior-surface FULL

Status: implemented

Review: FULL/2026-10-20#3/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

2026-10-20 首跑回填卡住：`evals/runs/2026-10-19/compare.md`（`evolve_eval_run` 机器输出 + 操作员填 commit）提交时，`verify-review-tier` 按 behavior-surface（`evals/**` 路径命中）判 FULL，要求三审证据。P5b 流程只写了"落盘后提交"，没给数据回填安排人审——机器产出的数字文件没有人类设计可审，逐次三审是仪式而非控制。防伪属性另有机械归属：`verify-eval-freshness` 要求 compare 的 commit 覆盖 HEAD，手造数字过不了 freshness 门。

## Decision

`classifyTier` 的 behavior-surface 分支加机器输出豁免：`evals/runs/` 前缀的路径永不命中（`EVAL_RUNS_PREFIX` 常量，注释写明归属）。人类维护的 evals（`tasks/`、`baseline/`、README）继续 FULL——改任务口径与基线快照是设计行为，仍须人审。豁免只看路径前缀，不看内容：run 明细（`report.json` 类）同样机器输出，同等豁免；若未来有人手写 `evals/runs/` 下的解读文档，按路径豁免是已知缺口（见 Consequences）。

## Alternatives considered

- **回填搭已审批次的便车（amend 进修门提交，复用其证据行）**：R1/R2/R3 简报把跑批数值列为 out of scope，证据行会为未审内容背书，属超范围背书。落败。
- **每次回填跑一次聚焦三审 + 迷你 ADR**：数字完整性核验（输出一致、commit==HEAD、DB 行数）是真实检查，但为机器输出逐次开 FULL（含 R1 简化/R3 归档两条与数字无关的 lane）是固定仪式成本；freshness 门已机械覆盖防伪。落败（若未来出现手造 compare 实证，再重议）。
- **`--no-verify` 豁免提交并明写原因**：CI 干净工作树下不红，今晚最快；但绕过门禁开先例，且缺口永久存在，每次回填都要单独拍板。落败。
- **豁免面扩大到整个 `evals/`**：`tasks/` 口径与 `baseline/` 快照是人类设计行为，P5a 明确其变更须同 PR 说明原因；一并豁免等于放掉任务集漂移的人审。落败。

## Consequences

下次四臂/外锚回填直接提交，不再触发 FULL；人类 evals 面不受影响。代价：路径豁免不看内容——若未来 `evals/runs/` 下出现手写解读文档，会被误豁免；届时按"内容豁免（机器输出标记）替代路径豁免"重议，本 note 为触发条件。`classifyTier` 新增分支由 `test/review-tier.test.ts` 的 LIGHT/-direction 双断言钉住（runs LIGHT、`tasks/`/`baseline/`/README FULL）。

## Testing

`test/review-tier.test.ts` 新增豁免用例；`./node_modules/.bin/vitest run test/review-tier.test.ts` 全绿；回填提交（`evals/runs/2026-10-19/compare.md` 单文件）`verify-review-tier --staged` 判 LIGHT；人类面（`evals/tasks/`、`evals/baseline/`、README）抽查仍 FULL。

## Related

- [三重审核 TS 门禁总规范](./2026-10-19-review-triple-ts-gates.md)：本 note 是其 behavior-surface 定义的局部例外（`evals/runs/` 永不命中），总规范本体不动。
- [P5a 评测基建](../testing/2026-10-19-p5a-eval-infra.md)：freshness 门与 compare 携带 commit 约定的上游家（防伪的机械归属）。
- [P5b 跑批与 runner](../testing/2026-10-19-p5b-eval-runner.md)：“落盘后提交”的流程上游家；本 note 补上该步缺失的 tier 语义。
- [freshness 门列表 commit 兼容](../bug-fix/2026-10-20-eval-freshness-dash-commit.md)：同一首跑暴露的另一处生产/消费错位，同批三审。
