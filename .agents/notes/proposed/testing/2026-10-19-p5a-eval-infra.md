# Agent Note: P5a 评测基建实现（evals 统一 + recall 接线 + caseTrace 表 + 防忘 infra）

Status: proposed

> 放置路径：本文件（`.agents/notes/proposed/testing/2026-10-19-p5a-eval-infra.md`）。
> 上游输入：总纲 `docs/plans/2026-10-19-architecture-supplement-plan.md` §2 D1/D10/D11 + §3 P5、RSI 计划 `docs/plans/2026-10-18-memory-skill-rsi-fitness.md` §5、召回 ADR（`proposed/architecture/2026-10-18-memory-recall-metrics.md` A/B）。
> 修订史：v1（2026-10-19 初稿）→ v2（同日会话内评审 `Request changes` 8 条后重写）→ v3（同日复审条件通过后增补：卡片行加回、基线更新纪律、fixture 改 JSON、`arm` 白名单、计数修正）。

## Problem

插件的机制越加越多（评审、分层提级、注入账本、预算三档、预筛、`notWhen`），但没有任何一条有"带来多少增益"的测量：`eval:recall` 只测索引召回不测任务结果，注入账本只测 adoption（正文被读），规则型记忆不读正文也生效、0% 反而是好信号。继续加机制而不加测量，半年后无法判断哪条该留。

v1 评审另指出两个现状约束，本版据此缩范围：`scripts/` 下的 `tsx` 拿不到宿主 `ctx`（`model-route.ts:28` 经 `ctx.get` 读模型，`eval-recall.ts` 能跑恰因纯离线）；`services/llm-call.ts` 的 `streamOnce` 是单轮 direct-call，不是带 `tool_calls` 的多轮任务求解器——真正的任务执行闭环在 P5a 不存在，只能到 P5b 设计。因此 **P5a 只含零 ctx 代码**（fixture、recall 接线、表结构与写入函数、防忘 infra），任何需调模型的 runner 归 P5b。

## 拍板记录（durable：本节即拍板出处，总纲 §2 D11 已同步为已拍板）

2026-10-19 会话问答逐项拍板：D11=A（宿主平面、复用 `llm-call` 路由；B 落败：新增密钥保管与费用纪律）；任务臂与 judge 同一模型（用户当前真实配置）；judge 同一模型独立判两次、一致才算；P5a 七项（新表 `eval_cases`、截断 query2k/预览 8k/回复 4k、评测跑批 100% 全存、脱敏复用 secret 筛查 + 去会话细节、5 条种子先验链路、recall 逐值比对即红、`runs/` 全忽略只交 `compare.md`）；P5b 五项（手动触发、flaky 两次 `acc` 制、预算按实测折算、四臂一次开满、外锚双月；另两项见 D11：同一模型、同一模型双 judge 一致）；防忘发版 blocking 门（纯文档改动豁免）+ 卡片 60 天标红行；外锚 60 天（workflow 检查）。

## Proposal

### 范围：P5a 只交付零 ctx 代码四件，需 ctx/模型的 runner 归 P5b

1. **fixture/负例统一住 `evals/`**：新建 `evals/tasks/*.json`（JSON 而非 YAML：零新依赖，现有 fixture 本就是 JSON，见 Alternatives）+ `evals/README.md`（格式 + 脱敏规则 + 维护周期）。任务 schema：`id/from（脱敏溯源占位）/prompt/expect（file-exists + test-pass + output-contains 判据）/tags`，外加可选 `recall:` 段（`query` 默认复用 `prompt`，`expect_ids` 为证据记忆 id，`negative: true` 表示断言零命中——负例即"不该命中"的表达，不 hanging 在 `expect` 为空上）。旧 `test/fixtures/recall/queries.json` 内容迁入种子后**删除**（单一事实源）；`eval:recall` 默认改读 `evals/tasks/`（`recall:` 段即召回 A 的 fixture 子集/视图），保留 `-- <fixture>` 覆写参数。P5a 只落格式与 5 条种子（三类记忆各 1 + 1 负例 + 1 冲突，覆盖全局 L0 至少 2 条中的首批）；20–30 条全量归 P5b。判据优先级：可执行断言 > 结构化比对 > 人工 rubric > LLM judge，前两档判不了的不入集。
2. **recall 接线**：基线文件 `evals/baseline/recall.json`（提交进仓库：逐 query 期望命中 + recall@1/3 快照）。`eval:recall` 输出 recall@1/recall@3/逐条覆盖（零命中记忆标红）/负例误命中；退出码 0=过，2=相对基线退化，1=fixture 不可用（沿用"空 fixture 恒红"纪律）。CI 以退出码非 0 即红。**基线更新纪律**：正当改进导致基线变化时走 `eval:recall --update-baseline` 刷新，且必须在同 PR 说明原因——手改基线无 blessed 路径，发现即打回。
3. **caseTrace 落库（新表 `eval_cases`，完整设计）**：列为 `run_id/task_id/arm/query/injection_preview/reply/created_at`，主键 `(run_id, task_id, arm)`，`arm` 带 `CHECK (arm IN ('base','current','candidate','reflect'))` 白名单并进 G6 快照（四臂值固定，按"白名单即单家"纪律）；`workspace_id` 记被测工作区（来源语义，与 `memories` 分区键同义；本表独立、无投影污染）。写入者为 data 层纯函数 `writeEvalCases`（插件代码写库，评测账本不走记忆提案门禁；调用方 runner 归 P5b，P5a 测试直调该函数）。迁移走 `migrate.ts` 链（`ensureEvalCases`，幂等 `CREATE TABLE IF NOT EXISTS`），G6 快照加表并同批重定基线。retention：`pruneIfDue` 新增 `pruneEvalCases`（30 天，与现有账本同口径）。脱敏：`secret.ts` 新增公开 `redactText`（把私有的 `redactSecret` 打码能力泛化为全文扫描掩蔽 `[redacted-<label>]`，含密钥必脱）；"去会话细节"定义为**表中不设来源会话列**（`source_session/source_seqs` 一律不存）+ `reply` 入库前过 `redactText`——可复现的是调用形状（query/预览/回复），不是事故叙述。截断 query 2k/预览 8k/回复 4k（拍板数，P5a 实测后回填调参依据，届时敢调）。
4. **防忘 infra**：新脚本 `scripts/verify-eval-freshness.ts`（纯离线：读 git 状态 + `compare.md` 头部），**仅发版预检跑**（`release-flow` 步骤 2 调用，不进 CI per-push 与 `run-gates all`）。`compare.md` 头部强制记 `commit/date/arms/结论`（载体即 `compare.md` 本身——`report.json` 在 `.gitignore` 内，干净检出读不到）。新鲜度按**发版窗口**定义：自上次发版 tag 起三面（记忆/技能/注入）有改动，而无覆盖 HEAD 的 `compare.md`，即 FAIL；纯文档/版本号改动（change-scope 无 `src/` 面）豁免。代价声明：每个带三面改动的发版都要先跑一次四臂（30 条 × 4 臂 + judge 双跑），这是 blocking 门的价，发版频率高时应合并发版。**卡片显形**：卡片加"上次四臂 X 天前 / 上次外锚 X 天前"行（读 store `state` 键，手动跑批的 runner 每次写入；无记录显"—"，超 60 天标红）；scheduled workflow 读 git log（已提交的 `compare.md` / `external-*.md` 历史），单一写者（runner）、两个视图，不打架。

### 执行平面边界（P5a 不碰，P5b 按此设计）

- `scripts/` 离线世界（fixture、recall、freshness 检查）与宿主在线世界（runner，经 `ctx.subagents` 调模型）以"是否需要 `ctx`"为界，`scripts/eval-tasks.ts` 的真跑部分活在宿主侧，`pnpm eval:tasks --list/--dry-run/--subset` 只做计划与本地校验。
- P5b 必须先设计多轮 `tool_calls` 求解环路（候选：宿主 subagent 带工具循环；不得自建传输，复用 `llm-call` 只解决单轮调用）；runner 内置 `--repeat 2`，两次 `acc` 比对判 flaky，成本双倍记账。

### 外锚 workflow（cron 化，自动/手动边界写死）

- `.github/workflows/eval-anchor.yml`，cron 每月 1 日（`0 9 1 * *`），跑 `scripts/check-eval-anchor.ts`：自动部分仅离线（`eval:recall` 全量 + 产物上传）；距上次 `external-<date>.md` 超 60 天 warning 播报，超 67 天 FAIL（60 天 + 7 天宽限，一句话可译）。
- 在线部分（四臂 + 外锚子集）永远手动（发版前 + 双月，烧 token，不许 CI 半夜自动花钱）。自建集 20% 轮换改到每次外锚时同步做。

### 产物与隐私（RSI §6 原样）

`evals/runs/` 全 `.gitignore`，只提交 `compare.md` 汇总与结论；任务输入只存脱敏后文本，会话 id/seq 作溯源占位；回归集上限 30 条/臂，`--subset` 支持临时 10 条。

### 递延给 P5b（方向已锁，数字待 P5a 实测）

首批开满四臂；触发为发版前 + 双月手动；同一模型双 judge；成本上限按 P5a 实测折算（30 条 × 单任务实测 × 臂数 + 缓冲），超限中止记 `budget_exceeded`；P5b 开工前按实测落死数字并重估工时（总纲 24 人日占位符届时重估）。

## Alternatives considered

- **caseTrace 加列到现有账本**：三账本各掺一脚，裁剪与快照全变复杂。落败：新表 `eval_cases`。
- **评测也抽样**：量本就小，省的量可忽略，复现还断裂。落败：评测跑批 100% 全存。
- **回复只存判据结果不存原文**：丢复现能力，D8"抽查失败行可复现"落空。落败：存原文 + `redactText` + 无来源会话列。
- **脱敏承诺降级为检出拒写**：`secretLeakReason` 现状即检测（返回 reason 拒写）。备选保留：若 `redactText` 误杀率高，P5a 可退到"含密钥回复拒写 + 记账"，不硬做 redaction。默认仍做 redaction（掩蔽可逆性无要求，审计读掩蔽后文本）。
- **P5a 一次到位 20 条**：判据 + 脱敏 + 溯源全压进实现批。落败：5 条种子验链路，全量归 P5b。
- **recall 只看均值容忍波动**：逐条覆盖空洞被均值淹没。落败：逐值比对、任何下降即红（exit 2）。
- **runs 全提交**：隐私与体积双输。落败：全忽略、只交汇总。
- **发版门按 HEAD 粒度 blocking**：每次发版都重跑四臂已是代价，HEAD 粒度等于每 commit 重跑，门禁必腐化（空 compare 骗门）。落败：发版窗口粒度。
- **发版门降为 warning（RSI P3 原语义）**：最诚实、最便宜。落败原因：用户已批 blocking，发版窗口粒度下成本可接受；warning 在发版 checklist 里等于可跳过，防不住忘。
- **runner 今批硬上（mock ctx / 脚本内直调）**：调通即事故——mock 的 ctx 测不出真实路由与工具循环。落败：runner 移 P5b，P5a 零 ctx。
- **独立双模型双 judge（RSI 原文）vs 同一模型双次**：前者是独立印证，后者是自洽抽查，口径确实收窄。落败独立双模型：成本翻倍 + 配置复杂度；同一模型双次已压住波动，且成绩直接代表用户真实配置（用户拍板）。
- **fixture 用 YAML**：可读性略好，但要新增运行时依赖（当前零依赖），还过一道依赖纪律。落败：JSON，node 原生解析。
- **砍卡片只留 workflow 播报**：少一行卡片代码，但发版窗口内的小步 src 改动（不发版）进入"无 compare 也不红"的盲区，唯一的日常可见提醒就没了。落败：卡片行加回（runner 写 state，卡片读，成本一行）。
- **CI nightly 自动跑四臂**：每夜烧 token 且 judge 波动误报红。落败：手动触发 + 过期变红。
- **外锚维持季度**：自建集最多带 3 个月偏差跑。落败：双月 60 天（用户拍板嫌季度长）。

## Acceptance criteria

- `pnpm eval:tasks --list` 输出任务数与判据分布，`--dry-run` 零模型调用；`--subset 10` 与 30 条上限可观察；
- `eval:recall` 输出 recall@1/recall@3/逐条覆盖标红/负例误命中；故意降一条期望即 exit 2 红；旧 JSON 已删除、默认读 `evals/tasks/`；
- `evals/baseline/recall.json` 在库（含 `--update-baseline` blessed 路径；手改基线无 PR 说明即打回），G6 快照覆盖 `eval_cases`（含 `arm` 白名单）；
- `eval_cases` 随迁移自动建；截断可观察（超长 preview 存入后为截断态）；塞一条带假 key 的回复，库内为掩蔽态；30 天裁剪可观察（`pruneIfDue` 覆盖）；
- 删 `compare.md` 跑发版预检得 FAIL；纯文档改动得过；三面有改动但 `compare.md` 记旧 commit 得 FAIL；
- 卡片"上次四臂/外锚"行可观察（无记录显"—"，超 60 天标红）；
- flaky 双跑、judge 双次一致、负例误命中三条逻辑有单测（P5a 可测部分：纯函数与脚本退出码；需模型的 runner 行为归 P5b 验收）。
