# Agent Note: P5a 评测基建实现（evals 统一 + recall 接线 + caseTrace 表 + 防忘 infra）

Status: implemented

> 放置路径：本文件（`.agents/notes/implemented/testing/2026-10-19-p5a-eval-infra.md`）。
> 上游输入：总纲 `docs/plans/2026-10-19-architecture-supplement-plan.md` §2 D1/D10/D11 + §3 P5、RSI 计划 `docs/plans/2026-10-18-memory-skill-rsi-fitness.md` §5、召回 ADR（`proposed/architecture/2026-10-18-memory-recall-metrics.md` A/B）。

## Problem

插件的机制越加越多（评审、分层提级、注入账本、预算三档、预筛、`notWhen`），但没有任何一条有"带来多少增益"的测量：`eval:recall` 只测索引召回不测任务结果，注入账本只测 adoption（正文被读），规则型记忆不读正文也生效、0% 反而是好信号。继续加机制而不加测量，半年后无法判断哪条该留。

另两个现状约束决定 P5a 只含零 ctx 代码：`scripts/` 下的 `tsx` 拿不到宿主 `ctx`（`model-route.ts:28` 经 `ctx.get` 读模型，`eval-recall.ts` 能跑恰因纯离线）；`services/llm-call.ts` 的 `streamOnce` 是单轮 direct-call，不是带 `tool_calls` 的多轮任务求解器——任务执行闭环归 P5b 设计。

## 拍板记录（durable：本节即拍板出处，总纲 §2 D11 已同步为已拍板）

2026-10-19 会话问答逐项拍板：D11=A（宿主平面、复用 `llm-call` 路由；B 落败：新增密钥保管与费用纪律）；任务臂与 judge 同一模型（用户当前真实配置）；judge 同一模型独立判两次、一致才算；P5a 七项（新表 `eval_cases`、截断 query2k/预览 8k/回复 4k、评测跑批 100% 全存、脱敏复用 secret 筛查 + 去会话细节、5 条种子先验链路、recall 逐值比对即红、`runs/` 全忽略只交 `compare.md`）；P5b 五项（手动触发、flaky 两次 `acc` 制、预算按实测折算、四臂一次开满、外锚双月；另两项见 D11：同一模型、同一模型双 judge 一致）；防忘发版 blocking 门（纯文档改动豁免）+ 卡片 60 天标红行；外锚 60 天（workflow 检查）。

## Decision

P5a 只交付零 ctx 代码，任何需调模型的 runner 归 P5b。

**fixture/负例统一住 `evals/`**：`evals/tasks/*.json`（JSON 而非 YAML：零新依赖）+ `evals/README.md`。任务 schema 含 `id/from/prompt/expect/tags` 与可选 `recall:` 段（`query` 默认复用 `prompt`，`expect_ids` 为证据记忆 id，`negative: true` 断言零命中）。旧 `test/fixtures/recall/queries.json` 内容迁入种子后删除；`eval:recall` 默认改读 `evals/tasks/`，保留 `-- <fixture>` 覆写。本批只落格式与 5 条种子（三类记忆各 1 + 1 负例 + 1 冲突），20–30 条全量归 P5b。

**recall 接线**：基线 `evals/baseline/recall.json` 提交进仓库；`eval:recall` 报 recall@1/recall@3/逐条覆盖/负例误命中，退出码 0=过、2=相对基线不一致、1=fixture 不可用。正当改进走 `eval:recall --update-baseline` 刷新且同 PR 说明原因，手改无说明即打回。

**caseTrace 落库（新表 `eval_cases`）**：列 `run_id/task_id/arm/query/injection_preview/reply/created_at`，主键 `(run_id, task_id, arm)`，`arm` 带 `CHECK` 白名单并进 G6 快照；`workspace_id` 记被测工作区。写入走 data 层纯函数 `writeEvalCases`（入库截断 + `reply` 过公开 `redactText` 掩蔽；无来源会话列）。迁移走 `migrate.ts` 链，`pruneIfDue` 经 `pruneLedger` 同口径裁剪 30 天。裁剪行实现在 `data/ledger.ts` 的汇总语句里（store 表面零新增，硬预算 400/12 不动）。2026-10-20 退役：写入面 `writeEvalCases` 与公开的 `redactText` 随四臂 runner 一并删除，`eval_cases` 表与 30 天裁剪保留（见 `../process/2026-10-20-architecture-drift-remediation.md`）。

**防忘 infra**：`scripts/verify-eval-freshness.ts` 仅发版预检跑（`release-flow` 步骤 2；`compare.md` 头部记 `commit/date/arms/结论`，新鲜度按发版窗口定义，纯文档改动豁免）。卡片"上次四臂/外锚"行读死键名 `eval:last-four-arm` / `eval:last-external`（值 `{"date","commit"}`，超 60 天标红）。`.github/workflows/eval-anchor.yml` 每月 1 日跑离线部分 + 检查（60 天 warning、67 天 FAIL），在线部分永远手动。

**执行平面边界**：`scripts/` 离线世界与宿主在线世界以"是否需要 `ctx`"为界；`scripts/eval-tasks.ts` 本批只做 `--list/--dry-run/--subset` 离线校验（`EVAL_TASKS_MAX` 30 条上限）。

**产物与隐私（RSI §6 原样）**：`evals/runs/` 全 gitignore（`compare.md` 与 `external-*.md` 除外）；任务输入只存脱敏文本。

## Deferred

P5b（方向已锁，数字待本批实测）：首批开满四臂，发版前 + 双月手动，同一模型双 judge，成本上限按实测折算，超限记 `budget_exceeded`，开工前重估工时。**P5b 开工前置**：runner 文件归宿先定（`src/services/` 受 G12 管 vs `scripts/` 另一套门禁），多轮 `tool_calls` 求解环路先设计（候选宿主 subagent 带工具循环，不得自建传输），runner 内置 `--repeat 2`。

## Testing

- `pnpm eval:tasks --list/--dry-run/--subset`：计数、判据分布、30 条上限、零模型调用；
- `eval:recall`：recall@1/3、逐条覆盖标红、负例零命中；降一条期望 exit 2 已实证；旧 JSON 已删；
- `eval_cases`：迁移自动建表、截断、假 key 入库掩蔽态、`pruneIfDue` 裁剪；
- 发版门：删 `compare.md` 得 FAIL、纯文档得过、旧 commit 得 FAIL（另有红绿 fixture 对）；
- 卡片行：无记录"—"、超 60 天标红、键名值形状直读库验证。

## Alternatives considered

- **caseTrace 加列到现有账本**：三账本各掺一脚，裁剪与快照全变复杂。落败：新表 `eval_cases`。
- **评测也抽样**：量本就小，省的量可忽略，复现还断裂。落败：评测跑批 100% 全存。
- **回复只存判据结果不存原文**：丢复现能力，D8"抽查失败行可复现"落空。落败：存原文 + `redactText` + 无来源会话列。
- **脱敏承诺降级为检出拒写**：`secretLeakReason` 现状即检测。备选保留：若 `redactText` 误杀率高，可退到"含密钥回复拒写 + 记账"。默认仍做 redaction。
- **P5a 一次到位 20 条**：判据 + 脱敏 + 溯源全压进实现批。落败：5 条种子验链路，全量归 P5b。
- **recall 只看均值容忍波动**：逐条覆盖空洞被均值淹没。落败：逐值比对、任何下降即红（exit 2）。
- **runs 全提交**：隐私与体积双输。落败：全忽略、只交汇总。
- **发版门按 HEAD 粒度 blocking**：HEAD 粒度等于每 commit 重跑，门禁必腐化。落败：发版窗口粒度。
- **发版门降为 warning（RSI P3 原语义）**：最便宜。落败原因：用户已批 blocking；warning 在发版 checklist 里等于可跳过，防不住忘。
- **runner 今批硬上（mock ctx / 脚本内直调）**：mock 的 ctx 测不出真实路由与工具循环。落败：runner 移 P5b，P5a 零 ctx。
- **独立双模型双 judge（RSI 原文）vs 同一模型双次**：前者独立印证，后者自洽抽查，口径收窄。落败独立双模型：成本翻倍 + 配置复杂度；同一模型双次压住波动且成绩代表真实配置（用户拍板）。
- **fixture 用 YAML**：要新增运行时依赖（当前零依赖）。落败：JSON，node 原生解析。
- **砍卡片只留 workflow 播报**：发版窗口内的小步改动进入盲区。落败：卡片行加回。
- **三处同读一组 state 键**：CI 读不到本机库。落败：键只约束 runner 写 + 卡片读；workflow 读 git log。不新增 `evals/last-runs.json` 第三个真相源。
- **CI nightly 自动跑四臂**：每夜烧 token 且 judge 波动误报红。落败：手动触发 + 过期变红。
- **外锚维持季度**：自建集最多带 3 个月偏差跑。落败：双月 60 天（用户拍板嫌季度长）。
- **eval 裁剪走独立 store 方法**：store-types 行预算与 store 出度预算双双告破（407>400、13>12）。落败：裁剪行并入 `pruneLedger` 汇总语句，store 表面零新增。

## Consequences

- 发版代价：每个带三面改动的发版先跑一次四臂（发版频率高时合并发版）；当前 main 自 v0.19.0 起 27 个三面文件无 compare，发版门呈红——首个带三面改动的发版必须等 P5b 首跑。
- 基线纪律：检索改进先 `--update-baseline` 再合，CI 把"改进未重锚"也判红（快照哲学与 G6 一致）。
- 成本：P5a 零模型调用；P5b 预算按本批 5 种子的单任务实测折算。
