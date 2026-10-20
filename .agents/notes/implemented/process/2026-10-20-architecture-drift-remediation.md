# Agent Note: 架构漂移收敛与归档区一致性（四批落地）

Status: implemented
Review: FULL/2026-10-20/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 立项依据：2026-10-20 对 v0.19.2 的只读架构审核＋卡片归档区体感核查。机器可判的架构面当时全绿（20 道门禁红绿俱验、typecheck/lint/945 测试），漂移全部落在门禁盲区与模块预算边缘。
> 待办入口：工作区 `HANDOFF-todos.md` 的 B1／B2／B3 三条 `[ ]`，随本批落地勾销。

## Problem

**退役面残留**。合成四臂评测下线后，`services/eval-taskset.ts` 生产零引用（`scripts/eval-tasks.ts` 自带 `validateTasks`、`scripts/eval-recall.ts` 自带 `loadTasks`），只有自己的测试引用它，而 `package.json` 的 `files` 白名单令它随包发布；`store.writeEvalCases` 只剩测试调用；`evals/runs/2026-10-19/compare.md` 没有生产者。这与 [architecture-standard.md](../../../../docs/architecture-standard.md) §3.1「退役必须删除／降级／改造，禁止旧路径保持全量接线」相抵。

**归档区信息与形态不一致**。卡片归档区把行渲染成纯文本（`标题 (id) · reason`），列表行走 `FileRow`（徽标、展开、预览），同一份记忆两套形态；`archive_reason` 以原始 token（`promoted-source`）渲染，中文界面裸出英文枚举；提级产生的行 `merged_into` 为空，卡片没有指向全局活副本的指针——读者看到的是"被撤销"，实际内容活在全局分区。

**结构饱和与分层松动**。`data/schema.ts`、`store-types.ts`、`data/migrate.ts` 各 400 行顶死，「全局行 − 本地遮蔽」这一条投影规则在 `store.ts`（只 active）与 `surfaces/memory-snapshot.ts`（`status != 'archived'`）各有一份实现，卡片合并集与注入／检索合并集可以分叉；`assemble.ts` 直读 `config.memoryIndex?.extraction`，而 §1 明文被委托方不读 Config，门禁 R3 只匹配 `.get(` 形态、看不见它；[coding-standard.md](../../../../docs/coding-standard.md) §3「`try` 只包一个语句」实测 116 个 `try` 里 63 个（54%）包多条，事务块是必要形态，规则既无例外条款也无门禁；`docs/plans/**`、`docs/research/**` 被评审档门禁当成行为契约面，纯计划文书也要 implemented ADR 承载 Review 证据。

## Decision

四批按 B1→B2→B3→B4 顺序落地、同批提交，各批的边界独立可核；硬边界对每批适用：四条不变量（注入不破坏组装、section 字节稳定、存储单写者、新机制声明回边与读者）不动；单文件 ≤400 行、出度 ≤12（组装根 14）、client 单函数 ≤80。

**B1 退役面清理（纯删）**。删 `services/eval-taskset.ts` 与其测试；删 `store.writeEvalCases`（接口成员／`Pick`／实现／`accounts.ts` 再导出）与 `data/eval-cases.ts` 的写入面，只保留 `evalCasesDdl`＋`EVAL_CASES_COLUMNS`（表形状；历史行仍在库里，30 天裁剪由 `data/ledger.ts` 的汇总 `evalPrune` 语句承担，`pruneEvalCases` 这个零调用函数随之删除）；`files` 移除 `evals/tasks/*.json` 与 `evals/baseline/recall.json`（两者仓内保留，月度 `eval:recall` 仍读它们；包内无读者）；`evals/README.md` 补 `compare.md` 无生产者说明；四处登记同步（`verify-layering`／`fn-shape-baseline`／`snapshot/api.json`／`budget-baseline`）。写入面独占的零消费者残件一并删除：三个 `EVAL_*_CHAR_CAP`（只服务写入门截断）、`EVAL_LAST_FOUR_ARM_KEY`／`EVAL_LAST_EXTERNAL_KEY`／`EVAL_STALE_DAYS`（P5a 卡片读数，读者已随跑批删除）。`redactText`（唯一调用者是那条写入路径）与 `EvalCaseWrite`／`EvalArm` 一并删除，`test/eval-cases.test.ts` 改写为三条断言（表形状、arm 白名单、「ledger 的 `pruneLedger` 仍按 cutoff 清掉旧 eval 行」）；`src/data/secret.ts` 的豁免登记不变（`redactText` 删掉后它仍只有 `secretLeakReason`，无同名测试）。

**B2 归档区一致性**。归档行改用列表行渲染器：`FileRow` 增 `readOnly` 分支（`div.dce-row` + `dce-row-readonly`，动作全关、无预览），归档区仍是折叠容器；`archive_reason` 的五个取值（含空值）进卡片内联字典（`client/client.js` 的 zh/en 段），归档行不再打印裸 token；`safeArchived` 一次读全局分区（不使用逐行查询），只对 `archive_reason === "promoted-source"` 且全局活行的 `origin_workspace` 恰为本工作区的行给 `globalCopyId`——分区按工作区隔离，别的分区同 id 的全局行不是这条记忆的活副本；全局分区视图不给自身指针；归档行的徽标标「内容在全局（id）」，并在 `globalCopyId` 与自身 id 不同时补一段 `id：<id>` 供人工对账（提级行 id 已出现在前一段，不重复印）。口径分叉（原 B2.4）随 B3.1 一次修掉。

**B3 结构收敛**。投影规则收成一处：`data/memory-reads.ts` 的 `globalOnly` 是「本地行遮蔽全局同 id 行」的唯一定义，注入 `list`、`search`、卡片 `mergedVisible` 三个读者各传自己的候选集；`mergedVisible` 落在 store 表面（`MemoryStore.mergedVisible`），`surfaces/memory-snapshot.ts` 删掉自己的合并实现、只渲染 store 的答案。`data/schema.ts` 的建表 DDL 下放到各表模块（`eval-cases.ts` 是既有先例）：`extraction_log`→`ledger.ts`、`item_events`→`item-events.ts`、`review_log`→`review-accounts.ts`、`memories`→`records.ts`，`schema.ts` 只留 guard 与聚合，并把 8 个符号回抛给 `migrate.ts` 保持其 import 面不变。形状按 region 归位：`SkillProposalOutcome`／`SkillFileWarning`／`SkillUse` 回 `services/skill-rules.ts`、`PromptProposalOutcome` 回 `services/prompt-rules.ts`，`store-types.ts` 只留接口与再导出。配置读取归位：`mountExtractionWhenAvailable` 改收已解析的布尔，`assemble.ts` 不再出现 `config.`，门禁 R3 扩到「非 `index.ts` 出现 `EvolveConfig` 即红」并配规则级红绿样例。类型收口：`rewriteBlockedReason` 的 `status: string` 改 `MemoryStatus`。`runExtractionInner` 的预检四守卫拆成 `preflightOf`（返回跳过结果或已收窄的 partition／route／call／surface），环函数回落到 80 行软预算内。

**B4 规范与门禁对齐**。`docs/coding-standard.md` §3 的 `try` 条款给事务／批处理加例外（判据是「`try` 内是一个完整事务/一条写入批」，不是语句条数）。棘轮 `--update` 需要 `--reason <ADR 路径>`：必须指向 `.agents/notes/{proposed,implemented}/*.md` 且文件存在，否则拒绝重定基线。`verify-review-tier.ts` 把 `docs/plans/**`、`docs/research/**` 移出行为契约面（`docs/` 顶层仍是契约面），配规则级红绿样例。

## Consequences

- 卡片与注入／检索不能再对「这个工作区看见哪些记忆」给出不同答案：只有一个投影函数，`test/memory-reads.test.ts` 钉住卡片 active 集与 `list` 集合相等。
- 提级产生的归档行不再读成"被撤销"：卡片给出全局活副本的 id。
- 行数：`data/schema.ts` 400→247、`store-types.ts` 400→388、`store.ts` 391→327、`data/eval-cases.ts` 119→43，新增 `data/memory-reads.ts` 89 行；DDL 的接收方相应变大——`data/ledger.ts` 274→318、`data/records.ts` 253→298、`data/item-events.ts` 189→217、`data/review-accounts.ts` 373→400、`services/skill-rules.ts` 201→223、`services/extraction-ring.ts` 243→271。`budget-baseline` 随本批重锚（`--reason` 指向本文）；`fn-shape-baseline` 与 `api.json` 同批按各自 usage 重锚，依据同样由本文说明。
- 门禁数量：G3 矩阵 20→22 对（`layering-r3`、`review-tier-docs` 为规则级样例；`test/gate-fixtures.test.ts` 相应改判「每个门禁脚本都被覆盖」而非一一对应）。
- 已知余量问题：`data/review-accounts.ts` 因接收 `review_log` DDL 恰好 400/400，零余量；下一个动它的变更必须先拆（daily 账户独立成模块是候选）。
- 已知未覆盖面：`surfaces/skill-snapshot.ts` 仍自带一份「本地技能遮蔽全局技能」的实现——本批的投影收敛只覆盖 memories（skills 的读路径不在其 diff 内）。
- 已知偏差（初稿到落地）：①`MemoryStore` 接口本身没有按 region 拆成多个 interface——腾预算改由形状归位＋读方法下沉完成，接口仍是一份完整契约；②B4.2 的理由校验读的是 `--reason` 指定的笔记路径，不是自动读本次变更集（门禁档位门禁 `verify-review-tier` 已有变更集判据，棘轮只守"有人写下理由"这一层），红绿由 `test/budget-ratchet.test.ts` 的单元样例覆盖而非 G3 矩阵（`--update` 会写文件，不适合放进静态红绿样例）。

## Alternatives considered

- **只做归档区（B2），不碰结构（B3）**：落败——投影分叉会让卡片与注入／检索的口径继续各走各的，预算饱和让下一次加字段仍要先拆文件，代价被推迟后支付得更高。
- **一次性大重构（投影＋schema＋store-types＋归档区同批）**：落败——单批必然判 FULL，评审面横跨存储与渲染，一处判定失误会同时挡住四类改动；按批推进让每一批的验收面各自可核。
- **把全局合并下沉进 `data/repository.ts`**：落败——repository 是 kind 泛型的行搬运层，分区合并是 memories 专有语义，下沉会污染泛型层并为 skills／prompts 引入用不上的概念；收敛点取 store 表面。
- **归档区只改文案、保留纯文本行**：落败——形态分叉的根因是两条渲染路径，只改文案会留下第二套渲染，下一次改徽标或加预览还要再改一遍。
- **退役面只标注不删除（保留 eval-taskset 与任务集在包内）**：落败——`files` 白名单仍在发包，随包携带一份包内无人读的任务集，且与 §3 退役规则冲突；标注无法阻止后来人重新接上它。
- **顺带删掉 `locale/*.json`（视为无引用残留）**：落败——它们是宿主插件元数据（title/description），`test/client-card.test.ts` 断言其必须在包内；把它当残留删掉会让插件在宿主列表里失去名称。
- **把 `MemoryStore` 拆成多个 region interface 再 extends**：落败（本批）——拆完 `store-types.ts` 仍是同一批方法声明，只是换了文件，出度与 import 面反而变宽；真正吃预算的是随方法走的 doc 与 shape，改由形状归位与读方法下沉解决，等下一次确实要往接口加成员时再拆。

## Feedback edge

回边：HANDOFF 行动区的三条 `[ ]` 是读者入口，随本批勾销并压缩为 `[x]` 指针。B4.2 的回边是棘轮门禁自身（拒绝无理由抬基线），B4.3 的回边是评审档门禁自身（计划文书不再被错误定档）。不新增常驻机制、不加定时器、不产生需要人复盘的新账本。
