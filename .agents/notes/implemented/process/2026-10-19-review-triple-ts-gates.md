# Agent Note: 三重审核 TS 门禁移植（档位判定＋简报冻结＋轮次收敛）

Status: implemented

Review: FULL/2026-10-19/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

本仓 `feature-flow.md` 步骤 5 只有一句话"重大变更：dsh-find-simplifications → dsh-code-review → dsh-archive-agent-notes，逐轮收口"。档位靠主会话自觉（desktop 仓 2026-09-03 已实证逃逸：组合根重构 + 门禁放宽 + 承诺三审的 ADR 只跑了一路 R2 轻审）；简报无固定形状、无界任务可中断取部分结论；工作树不冻结导致评审读的 diff 与提交物漂移；轮次无上限，复扫让 Blocker 越滚越多。2026-08-28 本仓跑过一次三路并行全仓审计，但那是一次性动作，没有落成每次变更的机械门禁。

## Decision

三重审核执行契约从 desktop 仓移植，门禁全部是 TS（`tsx scripts/*.ts`，与本仓单语言栈一致）：

- `scripts/verify-review-tier.ts` 做 FULL/LIGHT 机械定档，无执行者自由裁量。FULL 触发＝组装根（`src/index.ts`、`src/assemble.ts`、`src/store.ts`、`src/store-types.ts`）/ 门禁判据（`scripts/verify-*.ts`、`scripts/layers.json`、`scripts/fn-shape-baseline.json`、`cordis.patch.yml`、`.githooks/**`）/ 承诺三重审核的 proposed ADR（含"三重审核"字样）/ 行为契约面（`.github/workflows/**`、`templates/**`、`docs/**`、`client/**`、`evals/**`、`assets/**`）。FULL 随变更携带本批新产证据 `Review: FULL/yyyy-mm-dd[#N]/R1=ok R2=ok R3=ok`（implemented ADR 头区、单空格规范形、逐字不在 base、非改名继承）；不可达 base 判违规，不静默放行。`--changed-file` 供 G3 静态夹具列表模式（无 git 的 violation/clean 夹具），`--staged` 供 pre-commit，`--since` 供 pre-push（双参 `--since <base> --head <head>`，与 `change-scope` 同口径）。CI 只跑工作树兜底（干净检出恒过），真正的区间定档在 pre-push。
- `scripts/verify-review-brief.ts` 是评审启动前门禁（本地运行，不进 CI）。FULL 需 R1/R2/R3 三份简报，LIGHT 需 R2；简报固定结构（Scope base/head＋需深审面非空＋陪跑文件＋门禁自证 exit 全 0＋一层相邻件 / Directed checks 1–5 条 `- [ ]` / Explicitly out of scope ≥1 条 / Report contract 固定句）；工作树冻结（只有暂存项、无 `??` 散文件），冻结后 `git write-tree` 打印本轮 tree 即下一轮 `base:`；轮次只由文件名 `-r<K>` 取值，每路每批 ≤3 轮，超限需行首`轮次授权：`（用户显式），验轮只核处置闭合不复扫。`--repo` 不是 git 顶层时（仓内夹具目录）冻结/增量判据跳过，只判简报形状——G3 夹具即靠此语义。
- 执行契约在 `feature-flow.md` 步骤 5：范围＝单元 diff＋一层相邻；父级预消化简报（材料＋检查项，不给结论倾向）；有界并行上限两路（禁三路齐发）；确定性报告 `Blocker[]/Suggestion[]`（文件:行＋一句证据）；0 Blocker 即收口（Suggestion 书面裁定，不为建议再开轮）；行为第一证据＝测试＋门禁。留评审项在根 `AGENTS.md`「评审检查项（AI 兜底）」。
- 接线：`verify-review-tier` 进 `run-gates.ts` docs 矩阵（含 CI 工作树兜底）＋G3 红绿夹具＋`.githooks/pre-commit`（`--staged`）/ `pre-push`（`--since`）；`verify-review-brief` 进 G3 矩阵，简报存 gitignore 的 `.review-briefs/`。

## Alternatives considered

- **维持现状（自觉定档＋口头简报）**：零成本，但 desktop 2026-09-03 逃逸已证明纯文字条款拦不住执行者自判"这是纯结构重构"。落败。
- **直接搬 Python 脚本**：复用零改写，但本仓 2026-09-25 已 TS 化单语言栈（py 门禁全删），开倒车会分裂工具链，且 `tsx` 聚合与 typecheck 覆盖 scripts 的既有纪律被打破。落败。
- **只改文档不加机械门禁**：feature-flow 写细但无脚本强制，仍是自觉。desktop 的教训链（逃逸→简报自证→冻结→新鲜度→轮次收敛）每一步都是"只加文字又重演"后才机械化的。落败。
- **FULL 触发不含 docs/templates/client（只卡组装根＋门禁）**：误拦少，但本仓 docs 承载契约口径、templates/client 承载提示词与渲染契约，漏卡等于把契约变更放进轻审。落败；宁可 FULL 偏宽，LIGHT 由零行为变更判据走轻审。

## Consequences

- 收益：档位判定从自觉变机械（改门禁本身即 FULL，逃逸须对抗机器）；简报定界让评审一次完整跑完（无中断取部分结论出口）；冻结保证评审读的即提交物；轮次上限＋增量审终结复扫发散。
- 代价：FULL 偏宽，文档批也可能被迫三审——零行为变更判据＋轻审路径保留，误拦在 ADR 里收窄触发器；简报＋冻结增加单批操作步数——模板固定、tree 打印即拷，LIGHT 批只需 R2 一份；首批引入门禁的变更自身即 FULL，须自举跑一轮三审携带证据。
- 简报门禁不进 CI 是有意为之：简报是本地启动门禁（`.review-briefs/` gitignore），CI 只验档位证据。

## Testing

- `test/review-tier.test.ts` 17 例：规范形/日期/档位四类/零行为 LIGHT/承诺三审 ADR/staged 读 index（工作树剥离不降档）/工作树三态/陈旧证据触碰不复活/不可达 base 判红/夹具红绿。
- `test/review-brief.test.ts` 15 例：轮次取值/形状五项/门禁自证零与非零与多位 exit 与零条目/标题↔文件名互校/首轮处置段/验轮处置与上限与授权/Scope 区收窄（`rebase:` 不顶包）/缺简报/冻结三态/仓内夹具不上浮（`isSelfRoot`）。
- `verify-gate-fixtures.ts` 矩阵 21 门红绿全过（含新增两门）；`pnpm check:docs` 全绿；`typecheck`（app＋scripts）/lint 0 警告；全套 984 测试绿。
