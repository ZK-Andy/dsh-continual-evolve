# Agent Note: 杀死合成四臂与外锚，提示词补充调用面下线

Status: implemented

Review: FULL/2026-10-20#4/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

首跑复盘证明合成四臂不可留：任务集 18/22 输出判据中 5 个永不过（含 009 答对斐波那契被判 fail、022 最佳答案被判 fail）、1 个回归（007 注入把通用正确答案变成 deferral）、针非松即严；recall_hit 与臂无关；compare 只认 commit 不认数值；发版前置语义在实体拷贝分发下不可满足（两次发版全靠特批）。外锚一次没跑过，judge 任务集为空集，candidate/reflect 恒等。提示词补充全史 0 行，是比四臂更彻底的僵尸。继续留着=继续烧 token + 继续用不可满足的门逼特批。

## Decision

删执行链：`services/eval-{runner,solver,judge,report}.ts`、`surfaces/eval-tools.ts`（`evolve_eval_run` 注册）、assemble/index 接线与工具描述句。删门与锚：`scripts/verify-eval-freshness.ts` + fixture + `verify-gate-fixtures` 名单项、`scripts/check-eval-anchor.ts` + workflow 逼单步骤（月度离线 recall 照跑）、卡片四臂/外锚双行（含 client `evalLine` 与中英 locale）、release-flow 步骤 2、design 评测节、README 三工具→两工具、evals/README 回填流。`4866ae0` tier 豁免一并回滚（为死流程开的窗不留；人类面 FULL 名单扩展保留）。提示词补充删调用面：dispatcher `kind=prompt` 分支、`surfaces/evolve-prompts.ts`、`surfaces/prompt-snapshot.ts`、`pages/memory-card/prompt-routes.ts`（+card-routes 挂载）、`test/prompt-kind.test.ts`、文档提及；`services/prompt-{apply,rules}.ts` 留作休眠引擎（`audit-atomicity` 间接覆盖，`test-exempt.json` 豁免条目保留——新增豁免的 ADR 依据即本 note）；存储引擎（store 表面、records、repository、FTS、schema DDL、迁移链）休眠保留，0 行，有测试覆盖（`audit-atomicity` 仍以 prompts 仓验原子性），删它要动 compose-root，得不偿失。`evals/tasks`、`eval:recall`、基线、`eval-tasks` 离线校验全留（零 token 真门禁）。`evals/runs/2026-10-19/compare.md` 留作历史证据。`EVAL_LAST_FOUR_ARM_KEY` / `EVAL_LAST_EXTERNAL_KEY` state 键无 writer、无 reader、无 deleter、无过期机制，惰性残留（无害；retention 只扫账本表）。D3 关门：判维持冻结（合成数作废，待生产账本有反证再议；见 ## D3 关门）。

## Alternatives considered

- **只删 runner 留门**：门无执行器可读，freshness 会把所有三面发版永久拦死（默认 exempt 只在无三面改动时成立）。落败。
- **留 compare 入库流程只停跑批**：入库无生产者，门读旧 compare 永远 fresh，等于用过期证据永久放行。落败。
- **提示词补充连存储引擎一起删**：动 `store.ts` compose-root 与三仓共享方法（`buildCommonMethods` 等），60+ 处引用，风险不成比例；0 行 dormant 表无危害。落败（休眠+测试覆盖+本 note 记录）。
- **外锚改"暂停"不断根**：workflow 逼单与卡片行会继续报红/显示"—"，等于留一个永远响的闹钟。落败：正式"不做"，删逼单，留离线月检。
- **连 tasks/recall 基线一起删干净**：`eval:recall` 是零 token、CI 内真前置的唯一记忆相关回归信号（73.3% 基线，exit 0/2 红绿俱验），删了等于自废武功；任务集保留只为 recall 段服务，判据段已冻结不执行。落败。
- **重写任务集判据并保留跑批框架**：判据修好了，时间箭头（发版前新代码不可测）与成本天坑（N 分区 × 全量 × 双月）依然无解；任务集是下一套机制的输入，不是本批能交付的产出。落败。
- **D3 按口径字面重议而非直接关门**：实测 p95=2286 未达口径线（2000），按字面应重议。用户拍板否决：合成数来源已死，口径线早于 4000 预算迁移可能过期，维持冻结待生产账本反证再议。落败（被用户拍板覆盖）。

## Feedback edge

本 note 只删不增：唯一的"新东西"是锁（不变量 4 + 两模板小节）。读者：(1) 下次发版——不再被 freshness 拦，release-flow 步骤已同步；(2) CI——基线已重定，全绿即证；(3) 未来的机制作者与 R3——不变量与模板小节即执法点。触发动作均为"删后即生效"，无持续运行件。

## Consequences

下次带三面改动的发版不再被 freshness 拦；`evolve_eval_run` 调用返回"已下线"（工具注册移除，宿主不再列出）；卡片无 evals 行；`kind=prompt` 写入被拒（判词指引 memory/skill）。代价：合成 lift 数字不再产出，回归信心退回 vitest + recall + 门禁；若未来要恢复在线评测，按 P5b ADR 重建 runner（任务集须先按本 note 的判据教训重写）。回滚 4866ae0 后 `evals/runs/**` 重归 FULL——该目录不再有写入者，影响为零。

## Testing

`test/eval-{runner,report,tools,gates,judge,solver,seeded-store}.test.ts`、`test/prompt-kind.test.ts`、`test/fixtures/gates/eval-freshness/` 随代码同删；`review-tier.test.ts` 回滚 LIGHT/边界用例、保留人类面 FULL 断言；`fn-shape-baseline.json` 与快照按门禁自带 `--update` 重定；全量 `vitest` + `tsc` + `oxlint` + `check:docs` 全绿；`eval:recall` 实测通过（D3 证据）。

## Related

- [P5b 跑批与 runner](../testing/2026-10-19-p5b-eval-runner.md)：被杀的执行链出处；任务集判据教训见首跑数据分析（HANDOFF 滚动窗 2026-10-20）。
- [freshness 门列表 commit 兼容](../bug-fix/2026-10-20-eval-freshness-dash-commit.md)：同一夜修的门，随门同删。
- [tier 豁免 runs 数据](./../process/2026-10-20-tier-exempt-eval-runs.md)：一并回滚。

## D3 关门（用户拍板维持冻结）

合成 recall_hit（6/18）作废。实测：`eval:recall` recall@1=73.3%（exit 0，与基线持平）；`injection_log` est_tokens p95=2286（n=62，窗口仅 2 天，估算值）。P6 口径要求双条件（recall@1<90% 且 p95<2000）才维持冻结——recall 腿成立，p95 腿按字面不成立。用户拍板：口径线早于 4000 预算迁移可能过期，合成数来源已死，不重议，直接判维持冻结，待生产账本有反证再议。D3 closed。

## 防第四遍（锁）

`docs/architecture-standard.md` 不变量新增一条：**新机制立项必须声明回边与读者**（谁消费它的产出、消费后触发什么动作），无回边的机制不立项（展示类读数须标明"仅展示、无动作"）。ADR 模板（`templates/adr-implemented.md`、`templates/adr-proposed.md`）`## Alternatives considered` 之后加 `## Feedback edge` 小节（有回边必填，无回边写"无回边：展示面"并说明为什么；缺席视为未声明，R3 评审时必须要求补写）。R3 按模板核。
