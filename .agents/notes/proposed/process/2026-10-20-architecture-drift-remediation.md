# Agent Note: 架构漂移收敛与归档区一致性（四批修复计划）

Status: proposed

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 立项依据：2026-10-20 对 v0.19.2 的只读架构审核＋卡片归档区体感核查。机器可判的架构面全绿（20 道门禁红绿俱验、typecheck/lint/945 测试），漂移全部落在门禁盲区与模块预算边缘。
> 待办入口：工作区 `HANDOFF-todos.md` 的 B1／B2／B3 三条 `[ ]`，各指向本文 `## Proposal` 对应批。

## Problem

**退役面残留（B1）**。合成四臂评测下线后，`src/services/eval-taskset.ts` 生产零引用、只有测试引用，`package.json` 的 `files` 白名单令它随包发布；`store.writeEvalCases` 只剩测试调用；`evals/tasks/*.json`（22 个任务）与 `evals/runs/2026-10-19/compare.md` 没有生产者，前者仍在发包清单里。这与 [architecture-standard.md](../../../../docs/architecture-standard.md) §3.1「退役必须删除／降级／改造，禁止旧路径保持全量接线」相抵。

**归档区信息与形态不一致（B2）**。卡片归档区把行渲染成纯文本（`标题 (id) · reason`），列表行走带徽标、展开与预览的行组件，同一份记忆在两处两套形态；`archive_reason` 以原始 token（`promoted-source`）渲染，中文界面里裸出英文枚举；提级产生的 `promoted-source` 行 `merged_into` 为空，卡片没有指向全局活副本的指针——读者看到的是"被撤销"，实际内容活在全局分区（全库读数：归档 5 条全部为本工作区的 `promoted-source`，全局分区 0 条归档、6 条 active，其中 5 条与归档行同 id）。

**结构饱和与分层松动（B3／B4）**。`data/schema.ts`、`store-types.ts`、`data/migrate.ts` 各 400 行顶死，`memory-apply.ts` 395、`memory-section.ts` 392、`store.ts` 391——新增任何一行都要先拆文件，本月的守卫批已为此压缩过代码格式；「全局行 − 本地遮蔽」这一条投影规则在 `src/store.ts` 与 `src/surfaces/memory-snapshot.ts` 各有一份实现，状态过滤口径不同（`active` 对 `status != 'archived'`），卡片合并集与注入／检索合并集可以分叉；`src/assemble.ts` 直读 `config.memoryIndex?.extraction`，而 §1 明文被委托方不读 Config，R3 门禁只匹配 `.get(` 形态、看不见它；[coding-standard.md](../../../../docs/coding-standard.md) §3「`try` 只包一个语句」实测 116 个 `try` 里 63 个（54%）包多条，事务块是必要形态，规则既无例外条款也无门禁。

## Proposal

每批独立提交、独立回滚；硬边界对每批适用：四条不变量（注入不破坏组装、section 字节稳定、存储单写者、新机制声明回边与读者）不动；单文件 ≤400 行、出度 ≤12（组装根 14）、client 单函数 ≤80；**本计划不允许用 `tsx scripts/verify-budget-ratchet.ts --update` 把已饱和或已抬高的条目再抬一次**（B3 的目的正是腾空间）；每批按 `tsx scripts/verify-review-tier.ts` 定档并按其结论执行。

### B1 退役面清理（纯删，最小批）

| 项 | 动作 | 验收 |
|---|---|---|
| B1.1 | 删 `src/services/eval-taskset.ts` 与其测试；`scripts/eval-tasks.ts` 仍需任务集校验时把校验函数下沉到 `scripts/` 侧 | `pnpm test` 绿；tarball 清单无 `lib/services/eval-taskset.js`；`verify-api-snapshot` 重定后绿 |
| B1.2 | 删 `store.writeEvalCases` 表面与 `data/eval-cases.ts` 的生产导出，保留表 DDL 与 `pruneEvalCases`（历史行留在库里） | `verify-api-snapshot` 绿；`verify-schema-snapshot` 不变 |
| B1.3 | `evals/README.md` 写明任务集与已提交 `compare.md` 是历史留存、无生产者、不随包发布；`package.json` 的 `files` 移除 `evals/tasks/*.json` | `check:pack` 清单无 `evals/tasks`；`verify-pack-contents` 绿 |
| B1.4 | `verify-layering` 边表、`fn-shape-baseline.json`、`budget-baseline.json` 随删同步，只降不升 | `run-gates` 全绿 |

### B2 归档区一致性（卡片展示）

| 项 | 动作 | 验收 |
|---|---|---|
| B2.1 | 归档行复用列表行组件：只读、动作全关（拷贝／编辑／删除），`<details>` 折叠保留 | 卡片测试钉住两种行同形；client 单函数 ≤80 |
| B2.2 | `archive_reason` 进 locale：`promoted-source`／`review-archive`／`demoted-source`／`merged-duplicate`／空值各一条中英双份 | 界面无裸 token；两份 locale 键对齐 |
| B2.3 | 快照按 id 反查全局 `active` 行：命中则归档行标「内容在全局」并给全局行 id，未命中不显示 | `memory-snapshot` 测试覆盖命中与未命中两侧 |
| B2.4 | 卡片合并视图与读取合并口径分叉，随 B3.1 一次修 | 见 B3.1 |

### B3 结构收敛（碰 store 表面与配置读取）

| 项 | 动作 | 验收 |
|---|---|---|
| B3.1 | 合并投影收敛为 store 单一方法（如 `mergedVisible(workspaceId)`），卡片与读取共用，删 `memory-snapshot` 里那份 | 测试钉住同分区下卡片集合与 `list` 集合的关系；`verify-dep-cycles` 绿 |
| B3.2 | `data/schema.ts` 的 DDL 按表下放到各 `data/*` 模块；`store-types.ts` 按 region 拆接口文件 | `run-gates` 绿且 `budget-baseline` 对应条目下降 |
| B3.3 | mount 改收已解析布尔（与 `mountReviewWhenAvailable` 同款），解包只留 `index.ts` | `verify-layering` 增规则：非 `index.ts` 出现 `config.` 即红，并补红绿俱验样例 |
| B3.4 | `rewriteBlockedReason` 的 `status` 收成同模块的 `MemoryStatus` | typecheck 绿；`verify-api-snapshot` 重定 |

### B4 规范对齐（最小）

| 项 | 动作 | 验收 |
|---|---|---|
| B4.1 | coding-standard §3 给事务／批处理加例外条款（或删该条），措辞与 `data/tiering.ts`、`services/memory-apply.ts` 实态一致 | 文档门禁绿 |
| B4.2 | `verify-budget-ratchet` 的 `--update` 要求同变更带 ADR 说明（脚本层校验），防无理由抬基线 | 破坏样例红、正常样例绿 |

### 顺序、依赖与不做清单

B1 → B2（B2.4 依赖 B3.1）→ B3 → B4；B1 与 B2.1–B2.3 可并行提交，B3 触碰存储表面，宜单独一批一次拆完，B4.2 排在 B3.2 之后，避免棘轮规则先于收敛生效。

不做：归档复活与解除隔离（两者均为终态，见 ADR `2026-10-20-archived-rewrite-guard` 的 Alternatives）；注入预算档位与三档降级策略；`client/client.js` 的「单 bundle、无打包器」形态（§1 明文）；不引入新依赖。

## Alternatives considered

- **只做归档区（B2），不碰结构（B3）**：落败——投影分叉会让卡片与注入／检索的口径继续各走各的，预算饱和让下一次加字段仍要先拆文件，代价在被推迟后支付得更高。
- **一次性大重构（投影＋schema＋store-types＋归档区同批）**：落败——单批必然判 FULL，回滚面横跨存储与渲染，出问题时无法只回退一半；分批让每批独立可验证、可回滚。
- **把全局合并下沉进 `data/repository.ts`**：落败——repository 是 kind 泛型的行搬运层，分区合并是 memories 专有语义，下沉会污染泛型层并为 skills／prompts 引入用不上的概念；收敛点取 store 表面。
- **归档区只改文案、保留纯文本行**：落败——形态分叉的根因是两条渲染路径，只改文案会留下第二套渲染，下一次改徽标或加预览还要再改一遍。
- **退役面只标注不删除（保留 eval-taskset 与任务集）**：落败——`files` 白名单仍在发包，随包携带一份跑不起来的任务集，且与 §3 退役规则直接冲突；标注无法阻止后来人重新接上它。

## Feedback edge

回边：HANDOFF 行动区的三条 `[ ]` 是读者入口，动作是"下一批开工／跳过"；每批落地后按 feature-flow 收尾改滚动窗与 `[x]` 指针。B4.2 的回边是棘轮门禁自身（拒绝无理由抬基线）。不新增常驻机制、不加定时器、不产生需要人复盘的新账本。

## Acceptance criteria

- B1：tarball 无 `evals/tasks`、无 `eval-taskset` 产物，三张登记表无被删模块，`run-gates` 绿。
- B2：归档行与列表行同形且只读，界面无裸 `archive_reason` token，`promoted-source` 行标出全局活副本。
- B3：`budget-baseline` 对应条目下降，`verify-layering` 对非 `index.ts` 的 `config.` 读判红且有红绿样例，卡片集合与 `list` 集合的关系被测试钉住。
- B4：标准条款与代码实态一致，`--update` 缺 ADR 说明时判红。

## Risks

- **B3 触碰存储表面与 DDL 拆分**：ADR 需覆盖"迁移不动数据"，拆分期间 `verify-schema-snapshot` 必须保持不变；建议先拆 `schema.ts` 再动 `store-types.ts`。
- **B2.3 多一次读库**：卡片是请求时投影，反查限制为单工作区一次查询，避免按行发起。
- **分批推迟的风险**：B3 靠"下次需要往这三个文件加代码时"被动触发，可能长期不启动；如果连续两个版本没有触发，应在架构审核里重新排期。
