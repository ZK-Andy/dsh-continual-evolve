# Agent Note: P2 提取轨借鉴（两段式分类＋提案机械校验＋审计可回放）

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 放置路径：本文件（`.agents/notes/implemented/feature/2026-10-19-p2-extraction-track.md`）。
> 总纲入口：[架构功能性补充总纲 P2](../../../../docs/plans/2026-10-19-architecture-supplement-plan.md)（3 天，feature ADR）
> 出处库：[PilotDeck 差距分析 §5.1-7/§5.1-3/§5.1-2/§5.2-4](../../../../docs/research/pilotdeck-gap-analysis.md)
> AGPL 防火墙：施工只读 gap 分析 §5 中文描述与总纲，未打开 PilotDeck 源码仓库；无代码复制。

## Problem

单 prompt 提取有三处可观测性与准确性缺口：

1. **user/feedback 边界混淆。** 单 prompt 下归属三测全靠生成调用一次判断，Identity（是否描述人本身）/ Override（他项目可覆盖的规则）/ Output（约束回复格式与交付物）三类边界无独立分类先验，误收仓库事实。
2. **提案合法性只靠提示词约束。** 越界 id（伪造 update 目标）与未知 action 在 `parseExtractionAnswer` 静默丢弃、无计数，`applyProposals` 首个坏提案即整批 rejected——一个坏提案杀死整批好提案，且拒因分布不可统计。
3. **失败不可回放。** `extraction_log` 只有 `files`（成功快照或失败原文头），没有当时的调用 prompt，抽查失败行无法复现"为什么抽出这条"。

现状盘点（总纲要求开工先盘点）：动作闭集 `extraction-prompt.ts:239` 与 `memory-apply.ts:142` 各一遍、`sourceSeqs` 证据字段、`scope` 越界清洗（`person` 外一律 undefined）均已存在。P2 真新增仅三件：分类 prompt、id 求交、`droppedWarnings`。

## Decision

### 1. 两段式提取（分类 → 生成）

新增 `EXTRACTION_CLASSIFY_SYSTEM_PROMPT`（中文，与现有 prompt 同语域）：只分类不写记忆，输出 `{"worthy":[{"kind":"user|feedback|reference","evidence":"<原文引用>","test":"Identity|Override|Output"}],"reason":"…"}`，无值得项输出 `{"worthy":[],"reason":"…"}`。`evidence` 强制引用增量原文，无引用即视为无值得项。

新增 `classifyPrompt({incrementHead,userSeqs})`（输入与 cheap 门同形：增量头 `CHEAP_INCREMENT_MAX` 4000 字符＋用户 seq），`parseClassifyAnswer(text): ClassifyResult | null`（`null`＝传输级失败，见容错节）。

新增子代理定义 `extractionClassify`（`maxTokens: GATE_MAX_TOKENS` 1024，与 cheap 门同档），链变为 `[gateLink, classifyLink, proposeLink]`，分类 prompt 为环资产随 `extraction-ring.ts` 走：

- 分类成功且 `worthy` 为空 → **短路**：不调生成调用，游标推进，记 `model-skip (classify-none)`，零生成 tokens。
- 分类成功且非空 → 生成 prompt 追加 `<classification>` 先验块，系统 prompt 加一行"分类先验仅供参考，最终仍过归属三测"。
- 分类传输失败（LLM 抛错 / 非 stop finish / 解析 `null`）→ **fail open** 到生成调用（旧行为），先验缺席，`classify_error` 记账（见 §3）。 verdict 级"无值得项"才是不写，传输失败不 blocking——理由见 Alternatives。

`extractionPrompt` 签名扩展可选 `classification?: string`（缺席即旧形状，调用点零改动）。

### 2. LLM 提案机械校验（`memory-rules.ts` 唯一家）

新增纯函数 `identityRejectReason(proposal, allowedIds)`（`allowedIds`＝本工作区 active 记忆 id 集，调用方 `screenExtractionBatch` 处一次 `store.list` 已拿到，无新增读）：

- `action` 不在 `create/update/delete` → `unknown-action`。
- `update`/`delete` 的 `id` 不在允许集 → `unknown-id`（伪造越界 id 在此被丢，不进写门）。
- `create` 携带的显式 `id` 已在允许集 → `id-collision`（与 `createMemory` "已存在" 同语义，前移为逐条丢弃，不杀整批）。
- `type` 不在 `MEMORY_TYPES` → `bad-type`（现状在 `fieldGateReasons` 整批失败，前移为逐条丢弃）。

`parseExtractionAnswer` 的静默 `continue` 保留（解析层形状卫生），机械层做**计数型二次校验**（ defense in depth，不改 parse 返回形状）。`applyProposals` 的原子语义不动：机械层已丢弃后仍坏的提案才走整批 rejected（理论不可达，守卫保留）。

收敛方向：`memory-rules.ts` 为唯一家，`extraction-prompt.ts` / `memory-apply.ts` / `pre-screen.ts` 只调用它。三处校验长期收敛即刻完成，不留漂移窗口。

`ScreenReason` 扩展为 `duplicate | no-change | unknown-action | unknown-id | id-collision | bad-type`，`screenSkipReason` 聚合口径不变（`reason×n`）。

### 3. 审计：`prompt_json`＋`dropped_warnings`＋分类用量列（D8 纪律）

`extraction_log` 新增四列（TEXT，可空，`classify_usage`/`classify_error`/`prompt_json`/`dropped_warnings`）：

- `prompt_json`：`JSON.stringify({classify,userPrompt})` 截断后存。**只存失败与抽样**：失败行（`failed`/`rejected`）100% 存；成功行按 `runId` 确定性采样 **5%**（`hash(runId) % 20 === 0`，无随机、无测试抖动）；`skipped` 行不存（无调用可复现）。
- `dropped_warnings`：`JSON.stringify([{id,reason}])`，有丢弃即存（含全保留时空数组不存），失败原文头仍走 `files`（不动）。

递延数字（总纲 §7.5，在此定死）：

- 单条截断上限 **`PROMPT_JSON_MAX = 4000` 字符**（与 `CHEAP_INCREMENT_MAX` 同量级：够复现"调了什么"，不够撑爆单库；`dropped_warnings` 上限即单批 8 提案的 JSON，不另截断）。
- 成功采样率 **5%**（中央单库全工作区共享，既有 30 天裁剪在 `retention.ts`；5% ≈ 每 20 次成功多一行 4KB，年增量可忽略）。
- 两段式 token 增量预估：分类输入≈增量头 4000 字符（≈1000 tokens）＋输出≤1024 tokens（实测 verdict 约 200–400 tokens）；生成调用不变（40k 增量上限＋manifest＋候选，输出 4096）。分类只跑在 cheap 门通过的增量上（cheap 过滤约 70–80% 的 quiet turn），worthy 增量上调用数 1→2（翻倍），**全量 wake-up 平均增量约 3–5%**， funded by `classify-none` 短路省下的生成调用（短路一次省约 3–10k tokens，抵约 5–10 次分类成本）。

Retention：两列随行走既有 `pruneLedger` 30 天裁剪（`retention.ts` 不动，行删即列删）。G6 快照覆盖：`EXTRACTION_LOG_COLUMNS`、`extractionLogDdl`、`prepareLedgerStmts`、`writeMemoryLedger`、`migrate.ts` `ensure*` 链同步更新，`snapshot/schema.sql --update` 同 PR。

### 4. 落盘面

同 D5（`extraction-prompt.ts` / `memory-apply.ts` / `extraction-ring.ts` / 新增 `extraction-propose.ts` 提案环节桥模块 / `pre-screen.ts` / `memory-rules.ts` / `data/*` 同一份 ADR）。`evals/` 不碰（P5a 轨道）。提案环节从 ring 拆出是预算门禁倒逼（ring 518 行超 400 行硬预算，拆后 ring 292、propose 241），分层边表同步更新。

## Alternatives considered

- **分类传输失败也整批不写（字面 fail-closed）**：最贴总纲验收字"分类失败整批不写"，但把 transient 故障（超时/截断/429）变成丢忆——游标不推进则下轮重试可恢复，看似无损，实则每次重试多一次分类成本，且与 cheap 门 fail-open 纪律（"最坏回到旧行为，永不 stall"）自相矛盾。落败：verdict 级失败（模型明确说无值得项）才不写；传输级失败 fail open，`classify_error` 记账可观测。
- **分类 verdict 强制生成 skip（分类即门禁）**：分类说无、生成必须 skip，省一次调用但把分类误杀变成永久漏忆（生成无权纠正）。落败：分类是先验不是门禁，生成仍过归属三测独立判定；真正的省调用来自 `worthy==[]` 的短路（连生成都不调），误杀率由 fixture 锁定。
- **prompt_json 全量落库**：复现能力最强，但中央单库全工作区共享，全量 prompt（40k 增量＋manifest）数天即 GB 级，与既有 30 天裁剪初衷相悖。落败：失败全存＋成功 5% 采样（D8）。
- **成功采样用随机数**：实现最少（一行 `Math.random()<0.05`），但测试不可复现、同一 runId 两次行为不一致。落败：`runId` 确定性哈希采样。
- **dropped 入 `files` JSON 复用列**：零 schema 变更，但 `files` 现形状是数组（成功快照）或原文头（失败），混入 `{dropped}` 破坏"files 即 mutations/原文"契约，旧读端（卡片/回滚）需同步改。落败：独立可空列 `dropped_warnings`，读端零改动。
- **机械校验直接改 `applyProposals` 逐条跳过（破原子性）**：一个坏提案不再杀整批，但"部分落盘＋部分丢弃"让审计行语义分裂（applied 还是 rejected），回滚推理变难。落败：丢弃前移到机械层（写门外），写门内仍原子——门内容错即 bug，保留整批 rejected 语义。
- **三处校验各自补逻辑（parse/apply/screen 各写一遍）**：改动最小，但总纲已预警"三处校验长期会漂移"。落败：`memory-rules.ts` 唯一函数，三处只调用。

## Consequences

- 分类短路：`worthy==[]` 时零生成调用且 `classify_usage` 有账（`test/extraction.test.ts` P2 两段式三例）；传输失败回落旧行为且 `classify_error` 有账。
- 单坏提案不再杀死整批：伪造 id/未知 action/id 碰撞/非法 type 逐条丢入 `dropped_warnings`，好提案照常落盘（集成测试覆盖）。
- 失败行 `prompt_json` 100% 可复现当时调用；成功行约 5% 携带；超 30 天随行裁剪。
- G6 快照已同步，9 门红绿俱验绿，750 测试全绿（729 基线＋21 新增）。
- 风险残留：worthy 增量调用数翻倍，靠 cheap 门过滤＋短路对冲，P5 数字出来后复核（D3 输入）；`worthy==[]` 误杀靠 fixture 召回倾向＋OBSERVATION 落盘率观察；老库经 `ensure*` 幂等迁移，失败即启动失败。

---
