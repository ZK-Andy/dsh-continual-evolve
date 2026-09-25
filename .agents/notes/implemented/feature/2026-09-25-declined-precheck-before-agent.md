# Agent Note: 被拒指纹触发前预检（拒绝回路第二轮）

Status: implemented

## Problem

第一轮（`58daede`）把去重放在弹窗前，但模型调用已经花了：每次 checkpoint 照常唤起 Memory Agent（平均约 1,900 token/次），提案、被拒、审计，全套成本照付。今晚 104 次调用、20.5 万 token 里大部分是这种沉没成本。用户拍板"提前"：命中已拒内容时连 Agent 都不唤起。

## Decision

- `src/declines.ts` 扩展：台账条目加 `tokens`（标题+内容的 CJK tokenize 去重截断，上限 128，复用 `search.ts`）；新增 `matchDeclinedCheckpoint(entries, checkpointTokens)`，以后者对前者的覆盖度判定：覆盖 ≥0.85 且命中 ≥5 个 token 才算命中（双常量 `DECLINED_PRECHECK_COVERAGE`/`DECLINED_PRECHECK_MIN_TOKENS`，保守起步）。
- `recordDeclinedMemory` 改签名收 edits 数组：指纹/token/落盘收拢一处；写入前用 `secretLeakReason` 过标题+内容，命中则跳过台账（被拒照旧成立，只是不进抑制依据——被拒提案未经 engine 的 secret 门，不能持久化）。
- `auto.ts` 触发路径 eligibility 通过后、provider 解析前插入预检：命中 → 推进 memoryCheckpoint、记 noop 审计（rationale 注明 suppressed 指纹+覆盖度）、直接返回，不唤起模型。
- 匹配方向是"台账条目 ⊆ 新 checkpoint"（ containment），不是相似度对称值；改述到覆盖度以下仍会走 Agent（诚实局限延续第一轮）。

## Alternatives considered

- **阈值放宽（如 0.5）多省调用**：误杀=该记的没记且静默无弹窗，比多弹一次弹窗伤害大，拒绝。保守起步，用 suppressed 审计行攒样本再磨。
- **预检放 provider 解析之后**：无 provider 时抛错早于预检，测试与行为都不干净，拒绝。放最前，纯省。
- **台账存原文 content 而非 tokens**：文件膨胀 + 密钥形态文本落盘面扩大，拒绝。tokens 足够做覆盖度，且天然截断。
- **命中时不推进 checkpoint**：同一 snapshot 每轮重复触发，审计刷屏，拒绝。沿用 no-op 语义推进。
- **把规则写进提示词代替代码预检**：提示词预算只剩 117 字符，且"是否唤起"本就是宿主代码的职责，拒绝。判定逻辑放代码，提示词只保留原则句。
- **local 作用域入台账**：local 不弹窗、无调用可省（local 提案不走模型？不——local edits 也由同一次 Agent 调用产出；但抑制 local 会丢本地暂存语义），拒绝。仍只覆盖 project/global。

## Consequences

- 命中已拒内容的 checkpoint 零模型调用、零弹窗，只有审计行；`recordDeclinedMemory` 签名变化（未发版，无迁移问题）。
- 覆盖度/最小 token 数为常量，待 suppressed 样本攒够后按数据再磨（用户原话"逐步打磨"）。
- 测试：token 化/覆盖度/密钥跳过/触发路径单测；水位线不变（新文件分支 ≥83）。
