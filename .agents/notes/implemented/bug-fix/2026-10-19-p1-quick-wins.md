# Agent Note: P1 速赢批（卡片双读数＋事件档零变化门槛＋解析容错＋溯源默认）

Status: implemented

> 放置路径：本文件（`.agents/notes/implemented/bug-fix/2026-10-19-p1-quick-wins.md`）。
> 总纲入口：[架构功能性补充总纲 P1](../../../../docs/plans/2026-10-19-architecture-supplement-plan.md)（约 1.5 天，四项行为变更共一份 bug-fix ADR）。

## Problem

四处各自很小、合在一起才值得一次发版的速赢：

1. **卡片把"正文取回率"叫成召回，且单会话样本被当成趋势。** `injection-stats.ts` 的 `rate` 实为 adoption（注入后正文被取回的比例），规则型记忆 0% 是好现象；`injection_log` 7 天只有 1 行时卡片仍显示百分比（召回度量 ADR `2026-10-18-memory-recall-metrics` §C）。
2. **事件档会被零变化的牵连反复触发 LLM 评审。** `item_events` 是日志（事件新于最新完整判词即待审），目标条目自身无任何变化时，drain 仍为它花一次 LLM 调用——时钟档"无变化、到期也要看"有道理，事件档没有（总纲 D7）。
3. **裸控制字符让整批提案被丢弃。** 模型答案里混入一个 raw `U+0000`，`JSON.parse` 直接抛错，整轮记 failed 待重试——本可清洗后重解析。
4. **update 的来源语义没写下来，全靠巧合。** `updateMemory` 现状不写 `source_session`/`source_seqs`（建行时会话即永久来源），但没有任何测试锁定它；提取正文也偶带本轮事故叙述（如 `dislike-temporary-solutions` 类）。

## Decision

### 1. 卡片双读数（`injection-stats.ts` → `memory-snapshot.ts` → `client/client.js`）

- `InjectionStats` 带 `readThrough`（新正名）与 `latestInjected`（本次注入点名的条数，按 ts 取最大行 `ids.length`，与 store 排序解耦，无行时 0）；`rate` 是**废弃别名**（同值，下一 minor 删除），见 §Alternatives。
- 卡片行是「索引召回 N/M · 正文取回 K」：N=`latestInjected`，M=`snapshot.fileCount`（合并后的 active 数，含 L0），K=`read`；`sessions < 10` 时不显示比率，改示"样本不足"。中英 `injectionLine` 模板同步改（占位符 `rate` 改 `readThrough`），新客户端读 `readThrough`。

### 2. 事件档 `changed-since-last > 0` 硬门槛（D7：时钟档与抽样档豁免）

- 落点在 `collectCandidates` 的队列组装（`review-candidates.ts`），不是 batch：纯 lexical 事件分支（`similar`/`correction`，无 corrects 关系）要求 `record.updatedAt > reviewStateOf().lastTs`（最新**完整**判词，`reviewLast` 已过滤 incomplete 行，无需新 `state` 键、无需水位 reconcile）。
- **显式纠正豁免**：被 `corrects` 链接到的条目永远重入队列——纠正本身就是关于目标的新证据，即使目标行没动；该分支同时是前事件表时代的保底（无事件行仅有 link 的旧数据），绝不能变瞎。现代纠正（事件行 + link 双写）走 link 路径，不受门槛影响。
- 不满足的不入队，但**掉到时钟/抽样检查继续走**（豁免即豁免：到期复核与抽样不受影响，坏账 11-15 复核路径回归测试覆盖）。
- 记账：`collectCandidatesWithUnchanged`（原函数签名不动，内部共用），scheduler 用它拿到被滤掉的事件数，记 `review-unchanged-events` plugin_log（count + 前 20 个 id），drain 零 LLM 调用。不动 `review_daily`（`requeued = link+clock+sampled` 求和不变量保持，无 schema 变更，G6 快照不碰）。

### 3. 解析容错（`parseExtractionAnswer`）

- 首次 `JSON.parse` 失败后，剥离 `[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`（保留合法的 `\t\n\r`）重解析一次；成功则继续走正常路径。
- 仍失败 → 走现有 failed 路径（原文头 2048 落 `files`、增量不消费、下轮重试）。调用方不动。

### 4. 溯源语义（不加列）

- 默认值 = **不刷新**：`updateMemory` 保持不写 `source_session`/`source_seqs`，回归测试锁定（建行会话即永久来源）。"刷新来源"选项关闭；版本链与 D9 一并留给 P4 ADR。
- 提取 prompt 带一条正文规则：正文写可复用的事实，剥离本轮会话细节（事故叙述、临时状态、一次性过程），与归属三测同段。prompt 级约束，行为由观察验证。

## Alternatives considered

- **rate 直接改名不留别名**：干净，但桌面端 WebView 可能缓存旧 `client.js`（旧包读 `rate` → 新后端无该字段 → 渲染 NaN%）。落败：双字段过渡一版，旧包照样工作，新包读新字段，下个 minor 删别名并在发版注记写清需重启。
- **门槛放在 batch 层（reviewOneCandidate 里跳过）**：能复用现有计数，但候选已占 batch 位、已扣预算雏形，且 skip 行会重置 keep streak（无辜打破 30→60→120 豁免）。落败：队列层过滤，被滤的不占位、不扣预算、不写行。
- **被滤事件写 skip 判词行"消费"事件**：记账最强（每行可审计），但每条耗一次 reviewed 预算、重置 streak，且事件本就是日志、无需消费。落败：计数落 `plugin_log`（同等耐久），判词行只记真正的评审结论。
- **corrects 链接也过门槛（一视同仁）**：实现最少（一个分支条件），但纠正的本意就是"目标错了、快去看"，目标没动恰恰是常态；且前事件表时代的 link 是唯一重入路径，gate 会把它变瞎。落败：显式纠正永远豁免，只有纯 lexical 猜测过门槛。
- **被滤事件直接丢弃、不记数**：最省，但门槛是否生效无从观测（OBSERVATION 靠 drain 日志判断）。落败：一条 count 日志的成本可忽略。
- **update 刷新来源列**：来源永远指向最后一次编辑者，看似新鲜；但 P4 同源去重（D9 版本链）正要定义版本链指针，现在刷新会与版本链语义打架。落败：冻结现状，联合决策留给 P4 ADR。
- **正文去会话细节做机械屏蔽词**：屏蔽词表误伤正常规则（如"事故原因"本就是 feedback 必备的 Why）。落败：prompt 规则 + 人工观察。
- **control-char 清洗放调用方（settleProposalAnswer）**：parse 是多处复用的唯一入口（`subagent-defs` 两个定义都经它），放调用方会漏。落败：清洗进 `parseExtractionAnswer`，一次修全覆盖。

## Consequences

- 卡片同时显示「索引召回 N/M」与「正文取回 K」，`sessions < 10` 显示样本不足不显示比率；新旧客户端字段兼容测试覆盖（`test/client-card.test.ts`）。
- 零变化的事件档批次零 LLM 调用并有 `review-unchanged-events` 记账；时钟档/抽样档行为不变（既有 probation 复核与抽样测试全绿，无需坏账等到 11-15）。
- 裸控制字符提案清洗后走正常路径（`test/extraction-prompt.test.ts`）；仍失败保持原 failed 路径。
- `updateMemory` 回归测试锁定来源列不变（`test/store.test.ts`）；prompt 含去会话细节规则（文本断言）。
- 风险残留：双字段别名下个 minor 必须删（本 ADR 在 P4 开工前复查）；同毫秒编辑判为"无变化"（保守方向，可接受）；prompt 规则效果靠观察。
