# Agent Note: 收紧通用自动进化管线

Status: implemented

> 放置路径：`.agents/notes/implemented/feature/2026-09-25-tighten-general-auto-evolution.md`

## Problem

通用自动进化管线（通用 review `reviewAutoRefine`、通用 planner `planWithLlm` 的 prompt/skill 写、local fate `runLocalFatePhase`）又频又宽，用户已于 2026-09-24 暂停，当前生产走 `memoryOnly=true` 只跑 Memory Agent：

- 频繁：触发器是每成功回合一次 `turn_snapshot`（`agent/turn-stopping` + `agent/status=idle` 即调度，`intervalTurns` 已是 legacy）。机械过滤只有四项（非内部 agent、有新事件、非直接 memory 写、一句直接用户话 ≥3 词 `memoryMinUserWords=3`），日常一句话即达标，一问一答就是一轮 gate（全量模式下最多 memory + review + fate 三次 LLM）。
- 宽泛：review 的 user 兜底句（"对未来 turn 有用就 shouldRefine=true，优先 local"）把 system 里的窄门（重复失败/可复用战术/重复委派角色/窄行为策略）放宽；planner 的 local scope 指令（"优先 session 级编辑"）+ blastRadius（"拿不准选更窄"）让模型把单次交互抽象成 session 级 local prompt；prompt 没有 skill 那样的 consult + 冷却，直接 `engine.apply(local)` 落地；fate 的审计面是全部 local 条目，刚沉淀的转头就被问提升/归档。
- 3 词门槛错配：它抄自 ZCode 的降噪门（"有没有人说话"），不是价值门（"值不值得沉淀"）。用它驱动通用管线必然噪音。

## Decision

三方向全做，通用管线退到 wrapup/手动，turn 中只留 memory + 静默归档：

- A. review 加重复证据门：`AUTO_REVIEW_SYSTEM_PROMPT` 与 `reviewAutoRefine` 的 user prompt 要求单次交互默认 decline；同一模式在 trajectory 里出现 ≥2 次（重复失败/重复流程/重复纠正/跨 turn 复用信号）才可 `shouldRefine=true`，且 instructions 引用证据 span。
- B. planner 禁单次交互 local prompt/skill：`PLANNER_SYSTEM_PROMPT` 加与 guidance skill 同构的重复证据子句——prompt/subagent/skill 一律要求 trajectory 内重复证据，一次性流程永不提案；local scope policy 改为仅在重复证据下才可提案 session 级编辑，否则返回空 edits。local prompt 落地收敛到 `/evolve wrapup` 人审。
- C. fate turn 路径只静默归档：`runLocalFatePhase` 在 `turn_snapshot`/`turn_interval` 下不再 `consultLocalFates`（不弹窗），只执行 `silent-only` 归档；promote/split/review-archive 一律 deferred，审计行指向 `/evolve wrapup`。`compact` 保持 silent-only + deferred 语义；`goal_blocked` 保持独立计数器触发。
- 3 词门槛拆分：`memoryMinUserWords=3` 只属于 memory 相（ZCode 降噪语义，memory agent 自带 manifest/no-op/checkpoint 第二道门）；通用相不再共享该低门槛，本次不新增配置项。

## Alternatives considered

- **只调 3→8 词**：数字游戏。8 词依然拦不住"帮我把这段重构一下"这类单次指令，真正的病因是语义门太松，不是字符数。落败。
- **彻底删除通用 review/planner/fate 代码**：`runGate`/`planWithLlm`/`runLocalFatePhase` 仍是 wrapup/手动路径的共享实现，删除会断掉 wrapup。正确做法是收紧触发与提示词，保留函数供直接调用者使用。落败。
- **保留 turn 中 fate 弹窗但加长冷却**：冷却只减少打扰次数，不改变"单次沉淀转头就被审"的语义，治标不治本。落败。

## Consequences

- 收益：单次交互不再触发通用沉淀与弹窗；turn 噪音只剩 memory 相（自带 no-op）与静默归档；governed 动作统一收敛到 wrapup 人审。
- 代价：真实复用信号若只出现一次会被漏记，在会话收尾 wrapup 补回。
- 本次 blast 半径：提示词文本两处 + fate 一个分支 + 测试三文件；`memoryOnly=true` 生产路径行为不变（memory 相未动）。

## Testing

- `test/review.test.ts`：断言 system prompt 含重复证据门（at least twice / one data point is never enough）。
- `test/planner.test.ts`：断言 system prompt 含重复证据强制子句（mandatory / single one-off / empty edits）。
- `test/fate.test.ts`：turn 咨询语义改走 `goal_blocked`；新增 `turn_snapshot` 永不弹窗用例（governed deferred + 静默归档执行）。
- 全量 795 测试 / 48 文件通过；tsc/oxlint/四文档门禁全绿。
