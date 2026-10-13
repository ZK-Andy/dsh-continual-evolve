# Agent Note: 通用子代理与装载器（定义表 + 执行骨架 + 责任链）

Status: implemented

## Problem

插件里所有 LLM 调用都是**调用点内联**的：`src/llm-call.ts` 的 `streamOnce` 是唯一底层直调，feature 代码（`src/review.ts`、`src/extraction.ts`）直接 import 它，并在调用点写死身份、提示词与限制。

| 直调点 | 身份 | 内联在调用点的东西 |
|---|---|---|
| `review.ts` 便宜门 | 评审便宜门 | `REVIEW_CHEAP_SYSTEM_PROMPT` + `GATE_MAX_TOKENS` |
| `review.ts` 昂贵门 | 评审昂贵门 | `REVIEW_MEMORY_SYSTEM_PROMPT` / `REVIEW_SKILL_SYSTEM_PROMPT` + `EVOLVE_MAX_TOKENS` |
| 提取轨预检门 | 提取便宜门 | `EXTRACTION_CHEAP_SYSTEM_PROMPT` + `CHEAP_INCREMENT_MAX` |
| 提取轨主调用 | 提取 | `EXTRACTION_SYSTEM_PROMPT` |

三条后果：

1. **"有几个子代理、各自是什么"从代码里读不出来**。实际发生：四个岗位只写了三份说明书——技能便宜门缺位，被记忆门的说明书顶替，`ts-standards` 因此被拒 5 次（模型照着"你是记忆库的内容评审门"判，不是判歪）。
2. **记忆与技能共用一条轨**，而两者的家规相反（记忆要求"抹掉仓库名还成立"，项目技能要求"绑仓库"），只能靠 prompt 散文分支维系——`review.ts` 两处一个带 kind 分支、一个不带，漏点由此而来。
3. **加一份子代理、改一处限制，都要动调用点**；限制（预算/输出解析/路由）散落在各调用点，无法一处审阅。

账本侧同时有两个取证缺口（原独立待办「门失败行补 usage + model 列」）：`streamOnce` 在 error / 空文本分支抛错，**抛错前已观测到的 usage 就此丢弃**；`review_log` 没有 `model` 列、提取轨 `llm-failed` 行的 `model` 为空。判据是账本能直接回答「某次门失败跑在哪个模型、烧了多少 token」，实测两条都答不出（2026-10-13 真库：8 条 `gate-llm-failed` 的 `cheap_usage` 全空，`llm-failed` 行 `model` 全为 null）。

## Decision

- **子代理定义 = 策略，声明在一张表里**（`src/subagent-defs.ts`）：六份定义——`review-gate-memory` / `review-gate-skill` / `review-evolve-memory` / `review-evolve-skill` / `extraction-gate` / `extraction-main`。每份定义带身份、完整 system 提示词、预算 fallback、答案解析器；`REVIEW_GATE_BY_KIND` / `REVIEW_EVOLVE_BY_KIND` 是按条目 kind 的查表。加一个岗位 = 加一行定义。
- **装载器是唯一 LLM 入口**（`src/subagent.ts`）：`subagentLoaderFor({llm, route, sessionId})` 是简单工厂，`loader.run(definition, prompt)` 是 feature 代码唯一能碰到的调用口。`test/subagent.test.ts` 有一条结构性回归：`src/` 里出现 `streamOnce` 的文件只允许是 `llm-call.ts`（定义）与 `subagent.ts`（装载器）。
- **执行骨架是模板方法**：装配（路由/档位/预算）→ 调用 → 解析 → 记账固定，差异全部由定义注入。失败走**同一条骨架**：`streamOnce` 抛出 `SubagentCallError`，随错误带上已观测的 `usage` / `finish` / `route`（`observedUsageOf` 读取），截断答案经 `cutFailureOf` 走同一条路——失败行与成功行一样可归因。
- **流程推进是责任链**（`src/chain.ts` 的 `runChain` / `ChainLink`）：链路由环境类组装，环节只报 `handled` / `next`，无终局环节即 fail loud。评审环 = 门 → 昂贵门 → 落盘（`src/review-ring.ts`，`reviewChain()`）；提取环 = 预检门 → 提案调用（`src/extraction-ring.ts`，`extractionChain()`）。批量循环与调度器留在 `src/review.ts` / `src/extraction.ts`（后者拆出 `extraction-ring.ts`，双双回到 400 行预算内）。
- **预算按模型能力推导**：`selectMaxTokens(modelInfo, fallback)` 取模型自己广告的 per-request 输出上限（`defaultMaxTokens`），定义里的 `GATE_MAX_TOKENS` / `EVOLVE_MAX_TOKENS` / `EXTRACTION_MAX_TOKENS` 只做兜底；档位与预算共用同一次能力查询。同一模型同一预算间歇撞 max-tokens 由此从设计层消失。
- **账本补齐**：`review_log` 新增 `model` 列（旧库 `ALTER TABLE` 迁移），每条 verdict 行——含失败行——都记路由模型；提取轨与评审轨的 LLM 失败行、门失败行都带上已观测 usage；`llm-failed` 行的 `model` 取自调用自己的路由，不再依赖可能为空的 target。

## Alternatives considered

- **每个门一个子代理（维持现状）**：落败——身份与限制内联在调用点，"有几个子代理"读不出来；加一个岗位就漏一份说明书，已经发生（技能便宜门）。
- **用状态模式管流程**：落败——状态模式要求各状态在**编译期**就知道下一个是谁（迁移写死，等价 if/else-if），而环节需要增删；迁移写死正是现有 `kind === "memory" ? A : B` 硬编码分支的成因。责任链把"谁接谁"交给环境类组装，才容得下增删环节。
- **继续按 kind 在 prompt 散文里分支**：落败——无任何机械约束保证那句分支被读到、被执行。`f43d0ed` 只在昂贵门加了一句"项目技能绑仓库不是缺陷"，便宜门就漏了。
- **只把提示词抽成常量、不引入装载器**：落败——解决不了"直调"与"限制内联"，也读不出一份完整定义。
- **把账本缺口留作独立小改（先补列，再判 max-tokens 根因）**：落败——缺陷在同一个抛出点、两轨同病，独立小改要动同一处两次；并进返厂一次做完。
- **不落 route / usage，只靠失败行已有的 finish 文本归因**：落败——文本只区分 max-tokens 与 error，答不了跑在哪个模型、烧了多少，正是当时判不出根因的原因。
- **把 tools 一并做进定义**：落败——插件目前没有任何带工具的调用，为不存在的调用点造通用性只会得到一个没有调用者的字段；定义形状容得下它，真需要时加字段即可。
- **不动（保持 dry-run 静默）**：落败——结构性错误不修，下次会话会继续按层打补丁。

## Consequences

- 加/改一份子代理只动定义，不动调用点；"有哪些子代理"在一处可读，并由测试锁死 id 唯一与解析器接线。
- 四个评审岗位四份说明书——记忆与技能的家规相反这件事，由"各装各的"结构性保证，不再靠散文分支（技能便宜门此前确实缺位）。
- 所有直调经装载器后，路由解析、推理档位、输出预算、失败记账、用量留痕收在一处（不再散在调用点）。
- 失败行自带 usage 与 route：门失败率可按模型下钻，「先补列再判根因」这类取证不再需要；同模型间歇砍断的根因（固定预算）也在设计层消除。
- 代价：一次跨模块返厂（`src/llm-call.ts`、`src/subagent*.ts`、`src/chain.ts`、`src/review*.ts`、`src/extraction*.ts`、`review_log` 的列迁移及其测试），随下一批发版。本笔记取代按层修法的旧笔记 [2026-10-12-content-quality-evolution](../../implemented/architecture/2026-10-12-content-quality-evolution.md) 与 [2026-10-12-review-scope-and-dryrun-proposals](../../implemented/architecture/2026-10-12-review-scope-and-dryrun-proposals.md) 中关于分层修补的部分，并取代独立待办「门失败行补 usage + model 列」。

## Testing

- `test/chain.test.ts`：按序传递、异步环节、无终局环节 fail loud、空链 fail loud。
- `test/subagent.test.ts`：骨架传对 system/prompt/预算与 sessionId；模型广告上限覆盖定义 fallback；失败带 usage/finish/route；截断错误保留观测；定义表 id 唯一、解析器接线、记忆/技能两套门说明书不同；`streamOnce` 只允许出现在两个文件。
- `test/llm-call.test.ts`：`selectMaxTokens` 三态（取模型上限 / 兜底 / 元数据不可信即抛）；`streamOnce` 发送推导预算；失败（终局 error、空或截断、中途抛）都保留观测 usage 与路由。
- `test/review.test.ts` / `test/extraction.test.ts`：每条 verdict/ledger 行带 `model`；门与贵调用「报了 usage 再死」时 usage 落账；技能条目走技能门且带 scope；截断的提案调用是失败且保留 usage；失败行写账再失败时两个错误串联。
- `test/review-store.test.ts`：旧 `review_log` 迁移出 `proposed` 与 `model` 两列。
