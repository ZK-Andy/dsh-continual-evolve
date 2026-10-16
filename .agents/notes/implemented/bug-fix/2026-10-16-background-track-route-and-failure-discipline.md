# Agent Note: 后台轨三修：路由读会话当前值、失败分级熔断、账本表迁移

Status: implemented

> 放置路径：`.agents/notes/implemented/bug-fix/2026-10-16-background-track-route-and-failure-discipline.md`
> 讨论来源：2026-10-16 晚排查会话（用户："后台的 LLM 调用可能失败了多次" → "我已经切换模型，但提取轨并没有切换" → "还在无限重试，这是不对的"），当场拍板三项一批次实施；23:40 复核补齐五处缺口（分类输入、状态清理承载物、评审轨纪律、候选顺序、迁移的单一源与守卫）后开工，本会话按 D3→D1→D2 落地。
> 落地指针：`2426afd`（D3 存储）→ `d27dbca`（D1 路由）→ `4a7c448`（D2 失败纪律），三项各自带回归测试，**未发版**（发版需用户单独批准）。

## Problem

后台两条轨（提取轨 / 评审轨）在 2026-10-16 晚暴露三个独立缺陷，均在本机中央库与会话记录中实测复现（时间均为 CST）。

**一、路由取自创建期快照，会话中途换模型后后台轨继续打旧模型。**

两轨的路由解析都是"`agent.options` 优先、主机默认模型兜底"（`src/services/extraction.ts` 的 `targetOf`、`review.ts` 的 turn 监听），两者最终都走 `llm-call.ts` 的 `resolveCallRoute`。而宿主里 `agent.options` 是 agent 创建那一刻的快照（`dsh-agent-loop/lib/index.js:774`，全仓未见回写点）；会话中途换模型更新的是会话级选择（`dsh-api-session-controller/lib/index.js:277 selectionFor` + `modelSelection` 投影），下一次请求生效，不触碰 `options`。宿主自己的真值顺序是**投影 `pending` → `requestHeader().config` → 进程默认**；插件读的恰是被宿主降为兜底的那一档。

实证（桌面会话 `session-208035ea-a29e-4be5-9b45-2242d06198a6`）：22:14:24 建立时 profile 默认还是 `muse-spark-1.3-contributor`，22:14:45/48 会话选择切到 `deepseek-v4.1-flash`，首个 `request/header`（22:16:34）起全程 flash、整份会话记录 0 处 muse-spark；而提取轨失败行**全部**是 muse-spark。

**二、失败无分级、无退避、无熔断：每个回合边界重打一遍。**

截至 23:34 读库，同一会话已 **10 条 `status=failed`**（22:17:49 起，每回合两条：门调用 + 主调用），全部为

```
AUTH: dsh-opencode-go/muse-spark-1.3-contributor: opencode-go API error (403):
{"type":"RegionError","message":"This model is not available in your country"}
```

`extraction-ring.ts` 的失败分支只负责记账（一行 failed + `cheap_error`），不改变行为：没有终态/瞬态区分、没有连续失败计数、没有退避。而"失败不推游标"（有意设计，防丢内容）意味着每条重试都从会话头整段重发。

**三、老库账本表结构与代码漂移；审计行写在 COMMIT 之后，造成"改了但没痕迹"。**

`extraction_log.trigger` 的 CHECK 白名单在代码 DDL 里已含 `item-review`（2026-10-12 `9935876` 引入），但建表是 `CREATE TABLE IF NOT EXISTS`、迁移链（6 个 `ensure*`）**全部是 `ALTER TABLE ADD COLUMN`，没有一次重建表**——本机库（建于 2026-10-05）因此仍是 5 值白名单。22:06:26 评审轨对 `/mnt/work/work` 的 `dislike-temporary-solutions` 做 rewrite 落地，审计行撞 CHECK 抛错（被记成 `skip / review-failed`），而记忆本体已经 COMMIT：**本体已改、审计行丢失、台账记成失败**。三条落地通道同一形状（`memory-apply.ts`、`skill-apply.ts`、`prompt-apply.ts`）。

## Decision

### D1 路由真值按宿主的顺序解析，并留来源痕迹

`src/services/model-route.ts` 是路由的唯一家。四档按宿主自己的真值顺序探测，任一档不可达即退下一档，四档皆无维持 `no-route` 拒绝发送：

1. `sessionProjections.stateOf(session, "modelSelection")` 的 `pending ?? lastUsed`（下一次请求将使用的选择）；
2. `agent.session.requestHeader()?.config`（上一份真实请求头）；
3. `agent.options`（创建期快照，只作兜底）；
4. `agentDefaultModel.currentSelection()`（进程级默认）。

前两档是唯一跟着"会话中途换模型"走的两档，`pending` 排第一与宿主 `selectionFor` 同序——它在"已切模型、下一请求未发出"的窗口里就已经是对的。两轨在每个回合边界重解析（粒度不变，改的是优先级）。

每次 drain 启动落一行 `plugin_log`（`route-resolved`，带 provider/model、命中的档位、extract/review 归属）——"修复真生效"与"探测失败退回兜底"在账本上不再同形。评审轨的 `lastRoute` 同样带档位。

### D2 失败纪律：按宿主的机器码分级，终态熔断、瞬态退避

分类只读宿主的 `code`（`SubagentCallError.code` 取自终态 finish 的 `failure.code` 或中途抛错的 `cause.code`），不解析 message——宿主明说 `code` 才是可路由字段，而账本文本是 code、路由、provider 措辞的拼接产物。**终态**（重试无解）= `AUTH` / `NO_ADAPTER` / `PLUGIN_CONFIG`（插件自身的能力校验失败改为具名 `LlmConfigError`）；**其余一律瞬态**（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / 流中断 / 截断 / 没见过的 code）。

提取轨：判定点前移到 `drainScheduler` 入口、surface 读取与增量序列化之前。

- 终态 → 该会话的该路由进 halted（进程内 slot，不落库：没有 boot id 可存，而进程内状态天然"重启即解冻"），此后不再发调用；
- 瞬态 → 连续失败计数与退避记在 `state` 的 `extract:fail:<sessionId>`（自描述 `{count,until,route}`，档位 0 → 5min → 15min → 1h → 6h 封顶）；
- 成功、或解析出的路由与记录里的不同 → 清零；
- 被抑制的 wake-up **只丢边界、不动游标**（增量仍在，解冻后照常提取），并落合并行 `route-backoff` / `route-halted`；halt 与解冻各留一行 `plugin_log`。

评审轨：门/进化腿的失败码随条目上抛，批次遇终态即**整批中止**——落一行 `route-rejected`、其余候选留队不丢、每次 drain 至多烧 1 格预算；调度器随后把该路由整体熔断（同一路由下后续 drain 直接跳过，路由变化即解冻）。瞬态仍逐条 fail-open。

`pruneIfDue` 顺带清扫退避早已过期的 `extract:fail:*` 记录（7 天），会话静默后不再留下永久状态行。

### D3 账本表重建与审计行入事务

`src/data/schema.ts` 是表形状的唯一家：单表 DDL 参数化表名（新库与重建共用一份文本）、显式列清单、受限列白名单清单、漂移探测（按值集**相等**判定，多一个少一个都算漂）、事务内 `rebuildTable`（拒绝丢弃未列出的列、回放被一并 DROP 的索引）。`migrateDatabase` 在列迁移之后驱动它——列先补齐，形状再对齐。幂等判定是形状比对，不是子串搜索。

三个写入通道（记忆 / 技能 / 提示词）的审计行改为**与本体同事务**（`commitWithLedger`）：账本写不进去就整批回滚，不再是"本体已改、审计丢失"。技能通道的文件同步随之移进事务，其 `warnings` 才能随行落账；投影层的 throw 被记成 warning，不会因此丢掉可落盘的行。`rejected` 路径维持"ROLLBACK 后写行"。

## Consequences

- **原子性的边界变了**：CHECK 类失败从此是"整批回滚"（改不了就不改，fail loud），所以迁移必须先跑——否则老库会从"悄悄半改"变成"整条被拒不落"。
- **技能文件投影仍在事务内同步**（偏离"文件同步在 COMMIT 之后"的旧写法）：若随后的 COMMIT 被拒，文件会比库早一步，由巡检对账纠偏；文件操作本身按契约只返回 warnings，一个例外级 throw 也只记 warning。
- **评审轨的熔断粒度是"路由"而不是"会话"**：死路由一次 drain 至多消耗 1 格预算，此后不再发调用，直到路由变化。
- **本机库残留一条坏账**（`dislike-temporary-solutions`，22:06:26：本体已改、审计行缺失、`evolve_count` 少 1）。处置是留给评审轨自然重审——该条目的计数来自 `review_log` 行，重审那一趟自会补齐；不手写库（唯一写者纪律）。
- **宿主读取面是 duck-typed 探测**：`sessionProjections.stateOf` 与 `session.requestHeader()` 任一缺失就退到 `agent.options`（等于旧行为）。带"降级路径也算通过"的用例，并靠 `route-resolved` 痕迹区分"生效"与"降级"，避免假绿。
- **窗口期代价**：`route-resolved` 每 drain 一行、抑制行按合并计数、退避记录每会话一行——都由既有 prune 口径回收（后者 7 天）。
- 验收（实测）：本机库拷贝 815 行跑迁移后 `integrity_check` 前后均 ok、行数不变、白名单闭合为 6 值、`item-review` 可插、二次迁移幂等；新代码在拷贝上打开、写日志、清扫退避记录后正常关闭。
- 门禁：`pnpm typecheck && pnpm lint && pnpm test`（536 → **548** 测试）、`pnpm check:docs`、`check:budgets`（含新模块）、`verify-layering` 全绿；按文件覆盖率水位 91/83 保持。
- **未发版**：用户日常 profile 是 npm 实体拷贝，这三修到桌面端生效需发版（0.16.4）+ 重启 + 桌面验收（看提取行 `model` 是否跟会话、`plugin_log` 的 `route-resolved` 是否命中会话级档位）。

## Alternatives considered

- **D1 备选：维持 `agent.options` 优先，靠"换模型后重开会话/重启进程"兜住**。落败原因：这正是事故现状——后台轨静默打错模型，403 反复而账本只记失败、不记归因。
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
- **D2 备选：抑制行不落账（只靠 plugin_log 痕迹）**。落败原因：本项目对机械化决定一律"跳过并落账"；一条被抑制的 wake-up 同样是决定，按合并行计入才看得见"哪些回合被吞了"。
- **D3 备选：不重建表，改把 `item-review` 行写进无 CHECK 的表（`skill_log`/`prompt_log` 那一类），或干脆去掉 CHECK**。落败原因：(i) 审计行分裂到第二张表，破坏"一条通道一张账"与查询面；(ii) 去掉 CHECK 等于放宽唯一写者门禁，降低防线；(iii) 老库与新库继续漂移，同类事故会换形式再来。
- **D3 备选：只重建 `extraction_log` 这一张，不做单一源与复用件**。落败原因：这正是事故的成因形状（`CREATE TABLE IF NOT EXISTS` + 只有 ALTER 的迁移纪律管不到值集变更），下一次值集变更会原样复现；抽件成本小、复发成本大。
- **D3 备选：给 `extraction_log` 加 `route_source` 列来记路由来源**。落败原因：要改账本写入形状与类型、动两条写行路径，而"没有域账本的诊断"本就是 `plugin_log` 的职责；一行 `route-resolved` 即可区分"修复生效"与"退回兜底"。
- **D3 备选：审计行留在 COMMIT 之后，加 try/catch + 补偿写入**。落败原因：那是最终一致的临时方案（用户明确排斥），且失败时调用方拿不到真值；同事务原子才是彻底解。
- **D3 备选：每次启动无条件重建表**。落败原因：无谓风险与开销；形状比对 + 一次性执行已足够。
