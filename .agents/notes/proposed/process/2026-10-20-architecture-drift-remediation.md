# Agent Note: 架构漂移收敛与归档区一致性（四批修复计划）

Status: proposed

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 立项依据：2026-10-20 对 v0.19.2 的只读架构审核＋卡片归档区体感核查。机器可判的架构面全绿（20 道门禁红绿俱验、typecheck/lint/945 测试），漂移全部落在门禁盲区与模块预算边缘。
> 待办入口：工作区 `HANDOFF-todos.md` 的 B1／B2／B3 三条 `[ ]`，各指向本文 `## Proposal` 对应批。
> 落点口径：每条给 `文件:行`，行号取自 v0.19.2 后的 `b3ab32f`；施工时以当时 `git grep` 复核，不把行号当契约。

## Problem

**退役面残留（B1）**。合成四臂评测下线后，`src/services/eval-taskset.ts` 生产零引用（`scripts/eval-tasks.ts:33` 自带 `validateTasks`、`scripts/eval-recall.ts:59` 自带 `loadTasks`），只有 `test/eval-taskset.test.ts` 引用它，`package.json` 的 `files` 白名单令它随包发布；`store.writeEvalCases` 只剩测试调用；`evals/runs/2026-10-19/compare.md` 没有生产者。这与 [architecture-standard.md](../../../../docs/architecture-standard.md) §3.1「退役必须删除／降级／改造，禁止旧路径保持全量接线」相抵。

**归档区信息与形态不一致（B2）**。卡片归档区在 `client/client.js:932 archivedBlock` 把行渲染成纯文本（`标题 (id) · reason`），列表行走 `:565 FileRow`（徽标、展开、预览），同一份记忆两套形态；`archive_reason` 以原始 token（`promoted-source`）渲染，中文界面裸出英文枚举；提级产生的 `promoted-source` 行 `merged_into` 为空，卡片没有指向全局活副本的指针——读者看到的是"被撤销"，实际内容活在全局分区（全库读数：归档 5 条全部为本工作区的 `promoted-source`，全局分区 0 条归档、6 条 active，其中 5 条与归档行同 id）。

**结构饱和与分层松动（B3／B4）**。`data/schema.ts`、`store-types.ts`、`data/migrate.ts` 各 400 行顶死，`memory-apply.ts` 395、`memory-section.ts` 392、`store.ts` 391——新增任何一行都要先拆文件，本月的守卫批已为此压缩过代码格式；「全局行 − 本地遮蔽」这一条投影规则在 `src/store.ts:190`（`listRows`，只 active）与 `src/surfaces/memory-snapshot.ts:83`（`listAll`，`status != 'archived'`）各有一份实现，卡片合并集与注入／检索合并集可以分叉；`src/assemble.ts:90` 直读 `config.memoryIndex?.extraction`，而 §1 明文被委托方不读 Config，门禁 R3 只匹配 `.get(` 形态、看不见它；[coding-standard.md](../../../../docs/coding-standard.md) §3（`:23`）「`try` 只包一个语句」实测 116 个 `try` 里 63 个（54%）包多条，事务块是必要形态，规则既无例外条款也无门禁。

## Proposal

每批独立提交、独立回滚；硬边界对每批适用：四条不变量（注入不破坏组装、section 字节稳定、存储单写者、新机制声明回边与读者）不动；单文件 ≤400 行、出度 ≤12（组装根 14）、client 单函数 ≤80；**本计划不允许用 `tsx scripts/verify-budget-ratchet.ts --update` 把已饱和或已抬高的条目再抬一次**（B3 的目的正是腾空间）；每批按 `tsx scripts/verify-review-tier.ts` 定档并按其结论执行。

### B1 退役面清理（纯删，最小批）

- **B1.1 删 `src/services/eval-taskset.ts`（纯删，无下沉）**。导出面 `validateEvalTask`（`:64`）、`taskDirOfSelf`（`:119`）、`loadTaskset`（`:129`）生产零引用；两个脚本各带自己的校验/加载，故不存在"下沉"动作。随删清四处登记：`scripts/verify-layering.ts:100`、`scripts/fn-shape-baseline.json:178`、`snapshot/api.json:33`、`snapshot/budget-baseline.json`（同名条目）；`scripts/test-exempt.json` 未登记它，不必动。删 `test/eval-taskset.test.ts`。
- **B1.2 删 eval 写入面（保留表与裁剪）**。五处一起删：`src/store-types.ts:260`（接口成员）、`src/store.ts:39`（import 别名）、`:346`（Pick 联合里的键）、`:384`（实现体）、`src/data/accounts.ts:16`（再导出）、`src/data/eval-cases.ts:75`（`writeEvalCases` 函数体）。保留 `src/data/eval-cases.ts:47` 的 `evalCasesDdl` + `EVAL_CASES_COLUMNS` 与 `pruneEvalCases`——`src/data/schema.ts:22`、`src/data/migrate.ts:11` 依赖 DDL，历史行仍在库里（`docs/design.md` 已声明停止写入）。
- **B1.3 发包面收窄**。`evals/tasks/*.json` **是活数据**：`.github/workflows/eval-anchor.yml:9`（月度 cron）跑 `pnpm eval:recall`，`scripts/eval-recall.ts:54` 的 `TASKS_DIR` 直接读它，`scripts/eval-tasks.ts:33` 另做离线校验；但发行包内零读者（`scripts/` 不进 `files`），所以只从 `package.json:33` 的 `files` 移除，仓内保留。`evals/runs/2026-10-19/compare.md` 无生产者，在 `evals/README.md` 补一行历史留存说明。
- **B1.4 登记表随删同步**（同 B1.1 四处），只降不升。

验收：tarball 清单无 `lib/services/eval-taskset.js` 与 `evals/tasks`；`run-gates` 全绿；`verify-schema-snapshot` 不变。

### B2 归档区一致性（卡片展示）

- **B2.1 归档行复用列表行**：`client/client.js:932 archivedBlock` 改为复用 `:565 FileRow`，只读、动作全关（拷贝／编辑／删除）；列表与归档共用 `.dce-list`（`:507`）与 `.dce-files-title`（`:504`）样式；`:1000` 的 `archivedBlock(...)` 调用点保留在折叠容器内，`<details>` 折叠保留。验收：`test/client-card.test.ts` 补"两种行同形"断言；client 单函数 ≤80。
- **B2.2 reason 本地化**：卡片文案的家在 `client/client.js` 内联字典（zh 段 `:114`、en 段 `:174`，注册点 `:1801` 的 `ctx.locale.register(NS, {zh, en})`）——**不是** `locale/*.json`（那是宿主插件元数据 title/description，`test/client-card.test.ts:397` 断言它在包内，不动）。新增 `promoted-source`／`review-archive`／`demoted-source`／`merged-duplicate`／空值五条 reason 文案，归档行不再打印裸 token。
- **B2.3 全局活副本指针**：`src/surfaces/memory-snapshot.ts:162 safeArchived` 逐条调 `store.get(GLOBAL_WORKSPACE, id)`——`src/store.ts:143` 的 `get` 已实现"本地非归档优先、否则回落全局"，命中即说明全局有活副本；命中时归档行标「内容在全局」并给出全局行 id，未命中不显示。单工作区一次读，不按行发起。
- **B2.4 口径分叉**随 B3.1 一次修。

验收：界面无裸 reason token；`promoted-source` 行带指针；折叠行为不变。

### B3 结构收敛（碰 store 表面与配置读取）

- **B3.1 合并投影收敛**：`src/surfaces/memory-snapshot.ts:83 mergedMemoryRows`（`:121` 调用）与 `src/store.ts:190 unshadowed` 合一，落为 store 单一方法（如 `mergedVisible(workspaceId)`），接口面加在 `src/store-types.ts:213 MemoryStore`；卡片改为消费该方法。验收：测试钉住同分区下卡片集合与 `list` 集合的关系；`verify-dep-cycles` 绿。
- **B3.2 拆预算饱和的三个文件**：`src/store-types.ts:213` 的接口面按 region 拆文件后合并导出；`src/data/schema.ts` 的 DDL 聚合按既有先例下放——`src/data/eval-cases.ts:47` 的 `evalCasesDdl` 就是"表 DDL 跟着表模块走"的模板，`schema.ts` 只留 guard 与聚合。验收：`run-gates` 绿且 `snapshot/budget-baseline.json` 对应条目下降。
- **B3.3 配置读取归位**：`src/assemble.ts:90` 的 `config.memoryIndex?.extraction` 改为 mount 收已解析布尔，对照 `src/assemble.ts:146 mountReviewWhenAvailable` 收 `ReviewSchedule` 的写法；解包留在 `src/index.ts:255` 的调用处之前。门禁扩点：`scripts/verify-layering.ts` 的 R3（现只匹配 `config.X?.y?.get(`）加到"非 `index.ts` 出现 `config.` 即红"，并补红绿俱验样例。
- **B3.4 类型收口**：`src/services/memory-rules.ts:261` 的 `status: string` 改为 `:36` 的 `MemoryStatus`。
- **B3.5 已知告警**：`src/services/extraction-ring.ts:43 runExtractionInner` 实测约 82 行，超 `verify-src-budgets` 的软预算 80（只警告不失败）。二选一：随本批拆函数，或在标准 §2 写明环函数例外及其理由。

验收：`budget-baseline` 条目下降；`verify-layering` 对非 `index.ts` 的 `config.` 读判红且有红绿样例。

### B4 规范与门禁对齐

- **B4.1 `try` 条款**：`docs/coding-standard.md:23` 的「`try` 只包一个语句」给事务／批处理加例外（或删该条），措辞与 `src/data/tiering.ts:177`、`:226`（promote／demote 事务）与 `src/services/memory-apply.ts:95`（`applyProposals` 的 `BEGIN` 循环）的实态一致。
- **B4.2 棘轮 `--update` 要理由**：`scripts/verify-budget-ratchet.ts:101` 的 `--update` 分支与 `:75` 的新模块提示——把"同 PR 给出 ADR 说明"从文案改成校验（读本次变更集里的 ADR 文件，缺则拒绝 `--update`）。验收：破坏样例红、正常样例绿。
- **B4.3 `docs/` 定档过粗**：`scripts/verify-review-tier.ts:117` 的 `SURFACE_DIRS` 含 `docs`，`:147` 据此把 `docs/plans/**` 也判成行为契约面，纯计划文书因此需要 implemented ADR 承载 Review 证据（本文即因该判据改落 proposed ADR）。动作：为 `docs/plans/**`、`docs/research/**` 单列判据（判 LIGHT 或直接不进触发集），并在 `scripts/verify-review-tier.ts` 的 fixtures 补红绿样例。**该批改的是门禁判据（gate-criteria），机械定档为 FULL**——档位由 `tsx scripts/verify-review-tier.ts` 判定，纳入该批准入条件。

验收：计划类文档落盘不再触发 FULL；契约面文档（`docs/*.md` 顶层、`docs/design.md` 等）仍判 FULL 且样例红绿俱验。

### 顺序、依赖与不做清单

B1 → B2（B2.4 依赖 B3.1）→ B3 → B4；B1 与 B2.1–B2.3 可并行提交，B3 触碰存储表面宜单独一批一次拆完，B4.2 排在 B3.2 之后，B4.3 独立成批（改门禁判据，FULL）。

不做：归档复活与解除隔离（两者均为终态，见 ADR `2026-10-20-archived-rewrite-guard` 的 Alternatives）；注入预算档位与三档降级策略；`client/client.js` 的「单 bundle、无打包器」形态（§1 明文）；`locale/*.json`（宿主插件元数据）；构建输出目录（`lib/` 的 308 个产物是发布用的 tsc 输出，`.gitignore` 已忽略，缺省在 IDE 侧排除，不改 `tsconfig.outDir`）；不引入新依赖。

## Alternatives considered

- **只做归档区（B2），不碰结构（B3）**：落败——投影分叉会让卡片与注入／检索的口径继续各走各的，预算饱和让下一次加字段仍要先拆文件，代价被推迟后支付得更高。
- **一次性大重构（投影＋schema＋store-types＋归档区同批）**：落败——单批必然判 FULL，回滚面横跨存储与渲染，出问题无法只回退一半；分批让每批独立可验证、可回滚。
- **把全局合并下沉进 `data/repository.ts`**：落败——repository 是 kind 泛型的行搬运层，分区合并是 memories 专有语义，下沉会污染泛型层并为 skills／prompts 引入用不上的概念；收敛点取 store 表面。
- **归档区只改文案、保留纯文本行**：落败——形态分叉的根因是两条渲染路径，只改文案会留下第二套渲染，下一次改徽标或加预览还要再改一遍。
- **退役面只标注不删除（保留 eval-taskset 与任务集在包内）**：落败——`files` 白名单仍在发包，随包携带一份包内无人读的任务集，且与 §3 退役规则冲突；标注无法阻止后来人重新接上它。
- **顺带删掉 `locale/*.json`（视为无引用残留）**：落败——它们是宿主插件元数据（title/description），`test/client-card.test.ts:397` 断言其必须在包内；把它当残留删掉会让插件在宿主列表里失去名称。

## Feedback edge

回边：HANDOFF 行动区的三条 `[ ]` 是读者入口，动作是"下一批开工／跳过"；每批落地后按 feature-flow 收尾改滚动窗与 `[x]` 指针。B4.2 的回边是棘轮门禁自身（拒绝无理由抬基线），B4.3 的回边是评审档门禁自身（计划文书不再被错误定档）。不新增常驻机制、不加定时器、不产生需要人复盘的新账本。

## Acceptance criteria

- B1：tarball 无 `evals/tasks`、无 `eval-taskset` 产物，四处登记无被删模块，`run-gates` 绿。
- B2：归档行与列表行同形且只读，界面无裸 `archive_reason` token，`promoted-source` 行标出全局活副本。
- B3：`budget-baseline` 对应条目下降，`verify-layering` 对非 `index.ts` 的 `config.` 读判红且有红绿样例，卡片集合与 `list` 集合的关系被测试钉住。
- B4：标准条款与代码实态一致；`--update` 缺 ADR 说明时判红；计划类文档落盘不再触发 FULL，契约面文档仍判 FULL。

## Risks

- **B3 触碰存储表面与 DDL 拆分**：需在 ADR 里写明"迁移不动数据"，拆分期间 `verify-schema-snapshot` 必须保持不变；建议先拆 `schema.ts` 的 DDL 下放，再动 `store-types.ts`。
- **B2.3 多一次读库**：卡片是请求时投影，按工作区一次查询即可，禁止按行发起。
- **B4.3 改的是门禁判据**：把 `docs/plans/**` 降档的同时必须保住契约面仍判 FULL，否则等于给所有文档开绿灯；红绿样例是本批的硬验收。
- **分批推迟的风险**：B3 靠"下次需要往这三个文件加代码时"被动触发，可能长期不启动；连续两个版本未触发时应在架构审核里重新排期。

## 对初稿的三处更正（2026-10-20 自审）

- **C1**：初稿把 `evals/tasks/*.json` 与 `compare.md` 并列判为"无生产者"。实测任务集是活数据（月度 `eval:recall` 直接读它），只有 `compare.md` 无生产者；包内移除的理由从"无生产者"改为"包内零读者"。
- **C2**：初稿给 B1.1 写了"把校验函数下沉到 `scripts/`"，实为多余动作——两个脚本各自带校验/加载，删除即完。
- **C3**：初稿把"原因进 locale"写得像改 `locale/*.json`。卡片文案的家在 `client/client.js` 内联字典，`locale/*.json` 是宿主插件元数据，不动。
