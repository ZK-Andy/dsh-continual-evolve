# Agent Note: 后台轨三修：路由读会话当前值、失败分级熔断、账本表迁移

Status: proposed

> 放置路径：`.agents/notes/proposed/bug-fix/2026-10-16-background-track-route-and-failure-discipline.md`
> 讨论来源：2026-10-16 晚排查会话（用户："后台的 LLM 调用可能失败了多次" → "我已经切换模型，但提取轨并没有切换" → "还在无限重试，这是不对的"），当场拍板三项一批次实施、先落文档与待办，实施放到新会话；2026-10-16 23:40 复核补齐五处缺口（分类输入、状态清理承载物、评审轨纪律、候选顺序、迁移的单一源与守卫）及其痕迹面。
> 实施输入：本文档即实施清单（新会话按 §Proposal 的 D1/D2/D3 落地）。

## Problem

后台两条轨（提取轨 / 评审轨）在 2026-10-16 晚暴露三个独立缺陷，均已在本机中央库与会话记录中实测复现（时间均为 CST，读库时刻为 23:34 与 23:40）。

**一、路由取自创建期快照，会话中途换模型后后台轨继续打旧模型。**

两轨的路由解析都是"`agent.options` 优先、主机默认模型兜底"：`src/services/extraction.ts:202`、`src/services/review.ts:282`，两者最终都走 `src/services/llm-call.ts:203-206`。而宿主里 `agent.options` 是 agent 创建那一刻的快照（`dsh-agent-loop/lib/index.js:774`，全仓未见任何回写点）；会话中途换模型更新的是会话级选择（`dsh-api-session-controller/lib/index.js:277 selectionFor` + `modelSelection` 投影），下一次请求生效，不触碰 `options`。宿主自己的真值顺序是**投影 `pending` → `requestHeader().config` → 进程默认**；插件读的恰是被宿主降为兜底的那一档。

实证（桌面会话 `session-208035ea-a29e-4be5-9b45-2242d06198a6`）：

- 22:14:24 建立；建立时 profile 默认模型还是 `muse-spark-1.3-contributor`（patch 备份 `bak-20261015-lsp-remove` 记 muse-spark，今日 22:14 才改成 `deepseek-v4.1-flash`）。
- 22:14:45/48 会话选择切到 flash（`model/selection` seq 3/4）；首个 `request/header`（seq 15，22:16:34）起全程 flash，整份会话记录里 **0 处 muse-spark**。
- 提取轨失败行 **全部**是 `muse-spark-1.3-contributor`（见下）。

**二、失败无分级、无退避、无熔断：每个回合边界重打一遍。**

截至 23:34 读库，同一会话 **9 条 `status=failed`**（远多于排查当场看到的 5 条，且随回合继续增长）：22:17:49 / 22:21:57 / 22:47:47 / 22:55:48 / 23:04:41 / 23:11:25 / 23:22:28 / 23:27:53 / 23:34:05，全部为

```
AUTH: dsh-opencode-go/muse-spark-1.3-contributor: opencode-go API error (403):
{"type":"RegionError","message":"This model is not available in your country"}
```

`src/services/extraction-ring.ts:248-267` 只负责记账（一行 failed + `cheap_error`），不改变行为：没有终态/瞬态区分、没有连续失败计数、没有退避。每个回合边界先打一次门调用、再打一次主调用（门失败 fail open 到主调用），两次都白费。而"失败不推游标"（有意设计，防丢内容）意味着每条重试都从会话头整段重发——该会话连 `seq:` 游标都没有——prompt 随会话增长而膨胀（受 `incrementMaxChars` 上限约束）。

**三、老库账本表结构与代码漂移；审计行写在 COMMIT 之后，造成"改了但没痕迹"。**

`extraction_log.trigger` 的 CHECK 白名单在代码 DDL 里已含 `item-review`（`src/data/migrate.ts:42`，2026-10-12 `9935876` 引入），但建表语句是 `CREATE TABLE IF NOT EXISTS`——已存在的表不会被改写；迁移链（`src/data/migrate.ts:187-195` 及其 6 个 `ensure*`）**全部是 `ALTER TABLE ADD COLUMN`，没有一次重建表**。本机中央库建于 2026-10-05，表里仍是 5 值白名单（23:40 读 `sqlite_master` 复核：`trigger IN ('turn-debounce','compaction','close-drain','explicit','import')` + 三个 ALTER 列）。

实证：22:06:26 评审轨对 `/mnt/work/work` 的 `dislike-temporary-solutions` 做 rewrite 落地（写行触发点 `src/services/review-ring.ts:235` 的 `trigger: "item-review"`），撞 CHECK → 抛错 → 整条被记成 `skip / review-failed`（`src/services/review.ts:188-197`）。但记忆本体已经 COMMIT（`src/services/memory-apply.ts:76-85` COMMIT、`:104` 才写审计行），`updated_at = 2026-10-16T14:06:26.117Z` 与失败行同秒 → **本体已改、审计行丢失、台账记成失败**。三条落地通道同一形状：`memory-apply.ts:104`、`skill-apply.ts:342→359`、`prompt-apply.ts:220→222`（后两条因 `skill_log`/`prompt_log` 无 CHECK 而暂未爆，属同源隐患）。

副作用不止"缺一行审计"：那行的 `applied=0`、`evolve_count` 未 +1，而条目按计数排期 → 修复后该条目可能被提前再次重写（处置见 §批次前置）。

漂移面现状（23:40 全库 `sqlite_master` 审计）：**只有 `extraction_log` 漂了**；其余受限列（`memories.type`/`status`、`review_log.item_kind`/`verdict`、`skill_usage.scope`、`plugin_log.level`）与代码 DDL 一致。但"值集变更 = 必须重建表"这件事没有任何机制兜住——下一次（例如评审若覆盖提示词，`review_log.item_kind`）会原样复现。

## Proposal

### 批次前置：现状清点（只读，实施第一步）

1. 复核漂移面：逐表比对 `sqlite_master.sql` 的受限列值集与代码 DDL，确认本批要重建的只有 `extraction_log`（若已不止一张，按 D3 的清单一并驱动）。
2. 列出残留的"本体已改 / 审计记失败"行：`review_log` 里 `reason like 'review-failed: CHECK%'` 的行，按同秒 `memories.updated_at` 与 `run_id` 对齐，产出清单并定处置（回填审计行或小批重审），顺带修正该条目的 `evolve_count`。
3. 记录终态失败的基线行数（以实施时刻的库为准，不写死数字；本批起草时为 9 条且在增长）。

### D1 路由真值改为"会话当前选择"

两轨改为：**每个回合边界、每次 drain 前重解析路由，读会话当前选择**；`agent.options` 降级为兜底。读取面按"候选 → 探测 → 降级"落地（宿主面保持 duck-typed、零 DSH import，任一档缺失即退下一档），**顺序与宿主 `selectionFor` 对齐**：

1. `ctx.get("sessionProjections")` → `stateOf(agent.session, "modelSelection")` 的 `pending ?? lastUsed` —— 宿主写入的"下一次请求"选择（读取不需要 inject，注册才需要）；
2. `agent.session.requestHeader()?.config` —— 宿主上一份真实请求头（含 `adapterDefaults` 语义）；
3. `agent.options` —— 创建期快照，只作兜底；
4. `ctx.get("agentDefaultModel").currentSelection()` —— 进程级默认（`src/services/llm-call.ts:172`）。

理由：把 `requestHeader` 放首位会在"刚切模型、下一请求尚未发出"的窗口里读回旧模型——正是本次事故的时间窗。四档皆无时维持现状的 `no-route` 拒绝发送（不发死请求）。重解析粒度不变（`targetOf` 与评审轨的 turn-stopping 已经是每回合一次），改的只是 `resolveCallRoute` 内部的优先级。

**痕迹**：drain 启动时落一行 `plugin_log`（`event=route-resolved`，带 session、provider/model、命中的档位、随后动作 `run`/`halted`/`backoff`）。这一行是"修复真生效"与"探测失败退回兜底"的唯一区分面——ADR 自己的风险节已承认两者在账本上完全同形；"没有自己的域账本的诊断"本就是 `plugin_log` 的职责（`src/data/migrate.ts` 的 `plugin_log` 注释）。

评审轨 `state.lastRoute`（`src/services/review.ts:256/287/326/333`）同步换源，不新增库列（ledger 行已带 `model`，`cheap_error` 原文已带 provider/model）。

### D2 失败纪律：终态熔断 + 瞬态退避 + 路由变更解冻

1. **分级以宿主的机器码为准，不解析文本。** 宿主把稳定码放在 `LlmError.code` 上，并明说"route on this, never by parsing `message`"；账本里的 `LLM call error: AUTH: provider/model: …` 是"finish kind 前缀 + code + message"拼出来的，按前缀分类等于解析 message。故先给 `SubagentCallError`（`src/services/llm-call.ts:135-150`）**增 `code` 字段**（终态 finish 取 `failure.code`，中途抛错取 `cause.code`），分类只读该字段。
2. **档位表（白名单式终态）**：终态 = `AUTH`（401/403，含 `RegionError` 这类"此路由在本地区不可用"）、`NO_ADAPTER`、本地能力校验类确定性失败（如 `continual-evolve: invalid model …`）；瞬态 = `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`（宿主自身可重试集）+ 流中断 / 截断 + `no llm route`；**未知 code 一律落瞬态**。
3. **终态**：该会话（该路由）的提取轨进 halted——落一行 `status=failed`、`skip_reason` 用可辨识值（`route-rejected`），**同一路由下不再发调用**；解除条件：解析出的路由与失败时不同（换模型）、或宿主重启（halt 只住进程内 scheduler slot，不落库——插件没有 boot id，落库就得再造一个"重启即解冻"的假指针）。判定点在 `drainScheduler` 入口、`runExtraction` 之前（surface 读取与增量序列化都在后面，别每轮白做一遍）。
4. **瞬态**：连续失败计数 + 退避落 `state`（键 `extract:fail:<sessionId>`，值自描述 `{count,until,route}`），间隔递增：首轮立即 → 5min → 15min → 1h → 6h 封顶；成功或路由变化即清零。
5. **评审轨一并纳入**（不再是"维持现状"）：drain 级遇到终态即中止整批、落一行 `route-rejected`，其余候选留队；瞬态仍逐条 fail-open。理由：`consumeReviewBudget` 在调用**之前**就把 `reviewed` +1（`src/services/review.ts:163-168`），死路由一次 drain 会烧掉整批预算、且每个候选各发两次调用（门 + 进化）——10-16 的 `review_daily`（`reviewed=32`，`cheap-gate:5`、`review-failed:1`）就是这个形状。中止后每次死路由最多消耗 1 格。
6. **保留**"失败不推游标"（内容不丢），但重试一律受退避/熔断约束。
7. **状态清理**：`state` 表无时间列，故不为本批引入 schema 变更——判据用值里自带的 `until`：在既有 `pruneIfDue` 里新增一段，删除 `extract:fail:*` 中 `until` 已过期超过 7 天的键（会话早已静默，清掉最多让未来某一个回合从 `count=0` 起算一次）。`pruneLedger`（`src/store.ts:275-282`）现在只删 ledger 行，这一段是新增。`seq:` 游标的无界增长是既存事实、**不在本批范围**（另案）。
8. **痕迹**：halt 与解冻（路由变化后恢复尝试）各落一行 `plugin_log`，别只有 halt 有痕。

### D3 账本结构迁移 + 审计行入事务

1. **单表 DDL 抽取为单一源**：把 `SCHEMA_DDL`（`src/data/migrate.ts:12-181`）里 `extraction_log` 的建表语句抽成常量，**重建语句与新建库语句共用同一份字符串**，避免把 DDL 抄第二份（那本身就是新的漂移源）。
2. **受限列清单 + 复用重建件**：把"表 → 受限列 → 期望值集"抽成一份表，`rebuildTable()`（事务内 `CREATE TABLE _new(…单一源 DDL…)` → `INSERT INTO _new (显式列清单) SELECT …` → `DROP` → `RENAME`）与漂移判定共用该清单；本批只驱动 `extraction_log`，下一次值集变更只需在清单里加一行。该表无外键引用（全库 0 处 `REFERENCES`）、无索引、无触发器（23:40 复核 `sqlite_master`），实施时再以 `sqlite_master` 复核一次再定是否重建索引。挂进 `migrateDatabase` 末尾，遵循"每条迁移只加一处"的既有纪律。
3. **幂等判定改为形状比对**：读 `sqlite_master.sql` 做规范化（去空白/去注释）后与期望 DDL 比对，不用 `like '%item-review%'` 子串搜索（注释或列名都会误判）；等价方案是给库加 `schema_version` 整数，实施时择一。
4. **审计行入事务**：三条通道（`memory-apply.ts`、`skill-apply.ts`、`prompt-apply.ts`）的 applied 路径把账本写行移到 `COMMIT` 之前（本体与审计同成同退）；`rejected` 路径维持"ROLLBACK 后写行"不变，顺带消除"CHECK 违约时本体已落盘"的半截状态。**语义变化**：CHECK 类失败从此是"整批回滚"（改不了就不改、fail loud），所以**迁移必须先跑**（D3 内部顺序见下）。
5. **回归测试**（新增）：① 旧 DDL 夹具库（5 值 CHECK）跑 `migrateDatabase` 后能插 `trigger='item-review'` 行、重复跑幂等且数据不变；② 审计行写失败（桩让 `ledger.run` 抛）时本体回滚、错误上抛、账本留失败行（三条通道各一）；③ 路由四档优先级（投影 `pending` > `requestHeader` > `agent.options` > 进程默认）与全缺时的 `no-route`；④ `route-resolved` 痕迹行（含命中档位）；⑤ 失败分级：按 `code` 分类（`AUTH` 终态只记一次且此后不再发调用、未知 code 走退避）、瞬态按退避递增、路由变化即解冻；⑥ 评审轨 drain 遇首个终态即中止、不烧后续预算；⑦ `state` 清理只删长期过期的 `extract:fail:*`。相关既有测试文件：`test/extraction.test.ts`、`test/review.test.ts`、`test/data-ledger.test.ts`。

**实施顺序与批次**：D3 → D1 → D2（D3 先止血审计缺口并落地迁移；D1 去根因；D2 的"路由变更解冻"依赖 D1 的路由真值）。D3 内部再排序：单表 DDL 抽取 → 迁移（重建）→ 审计入事务（否则老库在入事务后会把合法写入整批拒掉，从"悄悄半改"变成"整条不落"）。三项一次批次、三个提交，各自带回归测试；本 ADR 随批次转 implemented（改 Status、移入 `implemented/bug-fix/`、`## Proposal` 改写为现在时 `## Decision`、验收与风险折进 `## Consequences`）。发版需用户单独批准。

## Alternatives considered

- **D1 备选：维持 `agent.options` 优先，靠"换模型后重开会话/重启进程"兜住**。落败原因：这正是本次事故的现状——后台轨静默打错模型，403 反复而账本只记失败、不记归因。
- **D1 备选：监听宿主"模型选择变更"事件重建 slot**。落败原因：依赖未证实的宿主事件面，且换模型只是变化源之一（还有 profile 默认变更、配置热改）；读"当前选择"是唯一真值源，事件面至多是优化。
- **D1 备选：`requestHeader().config` 排第一档**。落败原因：宿主自己把它排在投影 `pending` 之后；在"已切模型、下一请求未发出"的窗口里它仍是旧值，等于把事故窗口留在原地。
- **D2 备选：按失败文本前缀（`AUTH:` / `RATE_LIMIT:` …）分类**。落败原因：宿主的机器码在 `LlmError.code` 上、且明说不要解析 message，账本文本是拼接产物；前缀匹配会把新 code 悄悄归错档。
- **D2 备选：未知 code 一律按终态熔断**。落败原因：一个没见过的瞬态故障会永久搁置该会话的增量，直到换模型或重启；未知按瞬态只是多几次有界退避。
- **D2 备选：halt 状态落库、以"宿主重启"解冻**。落败原因：插件没有 boot id，落库就要再造一个"进程身份"指针，且重启不清理它等于永不自动解冻；halt 只住进程内存与"重启即解冻"的语义天然一致。
- **D2 备选：只加最大重试次数（例如 3 次后放弃）**。落败原因：放弃即永久不提取（丢内容），且瞬态故障会被一并放弃。
- **D2 备选：所有失败一视同仁熔断**。落败原因：太粗——网关抖动（`TRANSPORT`/`RATE_LIMIT`）会把本轮增量永久搁置。
- **D2 备选：只做终态分类、不加退避**。落败原因：瞬态故障仍每个回合边界重发整段，本次实测的浪费来源之一照旧。
- **D2 备选：评审轨维持逐条 fail-open**。落败原因：预算先扣后调，死路由一次 drain 烧整批预算并翻倍发调用，等于把 2026-10-16 那种浪费固定下来。
- **D2 备选：给 `state` 加 `updated_at` 列以便清理**。落败原因：本批按值内 `until` 自清已够；加列会把"清理老游标"这类有风险的事（删掉活会话游标 = 从会话头重提取）一并拖进来，另案再说。
- **D3 备选：不重建表，改把 `item-review` 行写进无 CHECK 的表（`skill_log`/`prompt_log` 那一类），或干脆去掉 CHECK**。落败原因：(i) 审计行分裂到第二张表，破坏"一条通道一张账"与查询面；(ii) 去掉 CHECK 等于放宽唯一写者门禁，降低防线；(iii) 老库与新库继续漂移，同类事故会换形式再来。**注**：`skill_log`/`prompt_log` 本无 CHECK，是否统一保留/取消 CHECK 另议，本文只决定"重建到与代码 DDL 一致"。
- **D3 备选：只重建 `extraction_log` 这一张，不做单一源与复用件**。落败原因：这正是本次事故的成因形状（`CREATE TABLE IF NOT EXISTS` + 只有 `ALTER ADD COLUMN` 的迁移纪律管不到值集变更），下一次值集变更会原样复现；抽件成本小、复发成本大。
- **D3 备选：给 `extraction_log` 加 `route_source` 列来记路由来源**。落败原因：要改账本写入形状与类型、动两条写行路径，而"没有域账本的诊断"本就是 `plugin_log` 的职责；一行 `route-resolved` 日志即可区分"修复生效"与"退回兜底"。日后若要做来源统计，再加列不迟。
- **D3 备选：审计行留在 COMMIT 之后，加 try/catch + 补偿写入**。落败原因：那是最终一致的临时方案（用户明确排斥），且失败时调用方拿不到真值；同事务原子才是彻底解。
- **D3 备选：每次启动无条件重建表**。落败原因：无谓风险与开销；幂等判定 + 一次性执行已足够。

## Acceptance criteria

- 老库（本机中央库）跑一次迁移后：`extraction_log` 可插 `trigger='item-review'` 行；重复迁移不报错、不改数据；迁移前后各跑一次 `pragma integrity_check` 均 ok。
- 评审 rewrite 落地时，`memories.updated_at` 与该条 `extraction_log` 审计行同事务落盘（同秒、同 `run_id`）；审计写失败时本体不变。
- 会话中途换模型后，同一会话的下一条提取/评审行 `model` = 新模型；且 `plugin_log` 的 `route-resolved` 显示命中**会话级档位**（投影/请求头），不是兜底档。
- 终态错误（`AUTH`/403）在同一会话同一路由下重复失败 ≤1 条，此后该会话不再出现 LLM 调用（无新账本行、无带路由痕迹的 run）；瞬态错误按退避重试（间隔单调不减），`state` 里可查到 `count`/`until`；路由变化后立即恢复尝试一次并留痕。
- 评审轨遇死路由：一次 drain 只消耗 1 格预算、落 1 行 `route-rejected`，其余候选留在队列。
- 批次前置清点产出残留"本体已改/审计失败"行清单及处置结果（回填或小批重审、`evolve_count` 校正）。
- 门禁：`pnpm typecheck && pnpm lint && pnpm test` 全绿（在 512 测试基线上新增上述用例）、`pnpm check:docs`；覆盖率不破 91/83 水位。

## Risks

- **宿主读取面不确定**：`sessionProjections.stateOf`、`agent.session.requestHeader()` 与 `agentDefaultModel` 都是 duck-typed 探测，任一档缺失即退下一档（等于现状）。因此落地必须带"降级路径也算通过"的用例，**并同时落 `route-resolved` 痕迹**——否则降级会以假绿的形式掩盖修复未生效。
- **DDL 抽取重构**：把单表 DDL 从整串里抽出时若不小心改动文本，新建库的形状会变；靠"新建库 vs 迁移后库形状一致"的回归用例兜住。
- **表重建**：事务内重建本机约 800 行审计表；实施前先备份库（先例 `_archive/evolve-db-backup-20261013/`），重建前后各跑一次 `pragma integrity_check`。
- **熔断可能搁置内容**：终态熔断期间该会话增量不提取，由"路由变化/重启解除"覆盖；不引入人工清除界面（避免过度设计）。若日后出现长期搁置，再按证据加处置入口。
- **退避状态膨胀**：每会话一个键，靠"`until` 已过期超 7 天"的判据在 `pruneIfDue` 里清；清理遗漏时键数与会话数同阶（可接受，但巡检要显式覆盖）。`seq:` 游标的无界增长属既存问题、不在本批。
- **`route-resolved` 噪声**：按合并后的 drain 粒度落行（一次 drain 一行），随 prune 一起回收；若日志面变大，再改成只在命中档位非最高档时落行。
