# Agent Note: absorb-memory-plugin-strengths

Status: implemented

## Problem

插件工程面已经成熟（CI 绿、单写者门禁、审计/版本/提级俱全），但三件最该被回答的事没有数字：

1. **跑的是哪一代代码不知道**。进程持有什么、盘面换没换，只能靠 `lib/` 的 mtime 与 `host.log` 的「子进程交接」行人工比对。
2. **注入的索引有没有被用不知道**。`memory_usage` 只回答「正文按 id 被读出」，回答不了「这次会话注入了 N 条，模型实际读了几条」。
3. **预算口径与实际不符**。`memoryIndex.maxChars` 是字符预算（默认 6000），中文按 1.2–1.5 token/字折算，实际约 7000–9000 token，而文档与卡片口径是「6k」。

另有三处形态缺口：注入超预算时整段截掉（被截掉的记忆连「存在过」都不告诉模型）；送 LLM 前后的提案没有确定性筛选；记忆只有「何时适用」，没有「何时不适用」。

2026-10-18 对 6 个同类插件调研（`FuRongJun-1999/dsh-memory`、`@kenz1117/dsh-engram`、`dsh-engram`（skepsun）、`dsh-engramory-recall`、`@max-null/dsh-memory`、`@openviking/dsh-memory-plugin`）后，只吸收观测与形态类改动；本地向量检索、服务端 + VLM、8 层记忆与元认知明确不吸收。

## Decision

### 观测（三件，均不改注入语义）

**代际自检**（`services/build-identity.ts`）。模块导入时对自身入口文件（`lib/index.js`）取 sha1 记为 `codeGeneration`；查询时重读盘面取 `diskGeneration`；两者不等即 `staleOnDisk` / `restartRequired`。任一侧不可读（`unknown`）一律判「不欠重启」。三处可见：`plugin_log` 每次 mount 的 `build-identity` 行、卡片首行、`memorySnapshot().build`。不新增工具面——同样的信息卡片与日志已够。

**注入账本**（`data/injection-log.ts` + `services/injection-stats.ts`）。表 `injection_log(workspace_id, session_id, ts, memory_ids, item_count, est_tokens)`，主键 `(workspace_id, session_id)`：section 每会话只构建一次（冻结语义），所以每会话一行，重复写入按 `ON CONFLICT DO NOTHING` 幂等。裁剪挂进既有 `services/retention.ts` 的 30 天日节流。读取侧算「注入条数 / 其中被读条数（`memory_usage.last_used_at >= 注入 ts`）/ 转化率」，卡片显示近 7 天。记账整体包在 try/catch 内，写失败只丢读数。

**预算单位**（`services/token-budget.ts`）。`estimateTokens` 按 CJK 1.5 token/字、其余 4 字符/token 估算，`fitTiered` 做三档装填。配置键改为 `memoryIndex.maxTokens`（默认 6000）；旧 `maxChars` 只在 `state` 的 `budget:index.migrated` 标记缺席时被读一次并按 `floor(chars/1.5)` 折算，随后只读新键。

### 形态（两件）

**有界索引三档降级**：整行放不下转 `- [id]` 行，再放不下收尾为「其余 N 条未展开」计数行。计数行不计入行预算（与指南文案同处理）——看不见的截断比粗估更糟。全部装不下时渲染「一条都放不下」提示。

**负条件 `notWhen`**：`memories` 加列 `not_when TEXT NOT NULL DEFAULT ''`，四处同变更（`data/migrate.ts` 的 DDL 与 `ensureMemoriesNotWhen`、`data/records.ts`、`store-types.ts`、`services/memory-rules.ts` 的 200 字上限门禁）。渲染为注入行尾的「（不适用：…）」（截 60 字）与卡片徽标；写入路径覆盖 `evolve_write` 与提取提案；**不参与检索过滤**。

### 筛选与度量（三件）

**确定性提案预筛**（`services/pre-screen.ts`）：`duplicate`（正文归一后与既有 active 记忆全等）与 `no-change`（update 携带的字段均未变）两类提案不落盘；整批被筛掉时推进游标并以 `pre-screen: duplicate×N` 记入 `extraction_log.skip_reason`。**只省写入与账本噪声，不省 token**——提案在模型作答后才存在，token 节省仍归 cheap gate。「正文太短」规则被否（见 Alternatives）。

**检索评测**（`scripts/eval-recall.ts` + `evals/tasks/*.json`，`npm run eval:recall`）：临时库播种固定记忆，跑固定查询，报 recall@1/recall@3；空 fixture 或指向未知记忆一律退出 1，相对基线不一致退出 2。首次运行暴露两处真实缺陷（见下），修后 9 查询 / 5 记忆 hit@1 100%——**这是冒烟级基线，不是基准测试**。

### 首次评测暴露并修掉的两处检索缺陷

- **CJK 长片段不可检索**：`"什么时候可以 publish"` 整段被当成一个 ≥3 字 token，要求标题里出现「什么时候可以」这个 7 字连续片段，于是零命中。改为按 3 字窗口展开（`searchAlternatives`），窗口内 OR、token 间 AND。
- **AND 语义吃掉自然语言**：窗口也凑不齐时整句零命中。增加第二趟：严格路全空且 token 多于一个时，退回 OR 重试（`matchSearch(..., "OR")`）。
- **索引顺序不确定**：`MEMORIES_ORDER` 缺 tiebreak，同 `updated_at` 的行顺序由 SQLite 自定，破坏「会话内字节稳定」。补 `, id ASC`。

### 落地面

新增 `src/` 文件五个（`services/build-identity.ts`、`services/token-budget.ts`、`services/injection-stats.ts`、`services/pre-screen.ts`、`data/injection-log.ts`），全部登记进 `scripts/verify-layering.ts` 的 `EDGES`；`src/index.ts` 的 section 装配收进 `surfaces/memory-section.ts` 的 `createSectionRenderer`，根只保留一次注册与 `buildRenderer` 挂钩（`apply` 回到软预算内）。`client/client.js` 增加运行代/注入转化两行与负条件徽标。

## Alternatives considered

- **不新表，把注入记录塞进 `state` 键值表**：落败。`state` 是「每 workspace 一个键」的形状，没有时间窗查询能力，统计要全表扫 JSON。
- **预算继续用字符、只改文档口径**：落败。文案不产生约束；真正的约束是 token，而「6k」已经写在三处，继续沿用错误单位只会让下次判断继续失真。
- **引入本地向量检索（engram 路线）**：落败。钱解决了，代价是重型依赖 + 50MB 模型下载 + 每轮 CPU 推理 + 新故障面，与「维护面越小越好」冲突。若注入转化率显示关键词检索确实不够用，再单独立项。
- **`notWhen` 做自动负路由**：落败。需要条件匹配引擎，是机制密度回潮；只做展示，让模型自己判断。
- **新增 `evolve_info` 工具暴露代际**：落败。新工具等于新对外契约，要进工具清单与 README；卡片 + 日志已够用。
- **F2 做成逐回合账本**：落败。与「section 每会话冻结一次」不符（装配并不逐回合发生），会写出大量重复行。
- **预筛加「正文太短」规则**：**实测落败并已移除**。阈值（18 token）在提取测试的既有夹具上误杀了真实提案，且「别用 rm -rf」这类短禁令是合法记忆。只保留字面全等与空更新两条不会误伤的规则。
- **预筛做「已被既有记忆语义覆盖」**：落败。判断语义覆盖需要语义，规则只能做字面全等；硬做会误杀同主题的新补充。

## Consequences

- 卡片三行新读数：运行代/盘面代（不一致标红）、近 7 天注入转化率、每条记忆的负条件徽标。`plugin_log` 多两类行（`build-identity`、`injection`）。
- 注入内容会变短（6000 字符 ≈ 4000 token 的折算），且超预算部分不再消失而是降级为 id 行；顺序因 tiebreak 在并列时变为按 id 稳定排序。
- 检索语义变宽：严格 AND 失败后回退 OR，可能带来相关度更低的候选；`test/store.test.ts` 的「AND 组合」用例已改写为记录该两趟契约。
- 接受局限：转化率只答「注入后是否被读」，不答「读了是否用上」（`memory_usage` 是聚合心跳）；不做逐回答埋点。
- 已知风险与兜底：记账写入失败只丢读数（单测断言异常时 section 文本与正常时逐字节相同）；`notWhen` 增加提示词负担，字段可选、超长拒绝、空串不渲染；评测是 5 记忆 9 查询的冒烟基线，改检索时以它为前后对照。
