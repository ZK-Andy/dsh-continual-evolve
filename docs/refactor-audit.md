# 重构审核报告（2026-08-18）

> 审核对象：dsh-continual-evolve 0.2.0 全量源码（src/ 32 个文件 ≈ 5.7k 行，test/ 24 个文件 ≈ 5.4k 行，86 个 describe 块）。
> 基线：`pnpm typecheck` 通过、`pnpm lint` 0 警告 0 错误。
> 结论：**结构总体健康，无需大重构**；需要一轮"外科手术式"小重构（2 个 P1 + 2 个 P2 + 若干 P3），不动任何行为。

---

## 1. 当前结构评估（好的部分）

```
types.ts (数据模型)
  → state / store / apply / rollback / validate (纯核心 + 持久化)
  → service.ts (engine 门面：唯一变更入口，快照/审计/持久化/副作用边界在一处)
  → 表层 tool / command / inject / logfile / mount
  → 门禁 auto / review / planner / fate / wrapup / goal
  → 基准 benchmark / rubric / score / evaluate / pool
  → 技能 skill / skillquality
```

值得保留的现状（重构时不得破坏）：

- **单点变更漏斗**：所有状态变更都过 `service.ts` 的 `engine.apply`（snapshot-before-write、审计、持久化、onApplied 副作用强制合一）。
- **纯函数/副作用分离**：机械逻辑（`filterPromotable`、`splitArchiveGuards`、`planLocalFates`、JSON 解析等）全部纯函数化并可单测。
- **wrapup 与 fate 共享 proposal builder**：`wholePromoteProposals` / `splitPromoteProposals` 由两条路径复用，保证写入完全一致——这是有意设计（fate.ts 头部注释说明）。
- **服务访问的 duck-typing 纪律**（FAQ #1）：`goalServiceOf` 等惰性解析，可选服务不成为硬依赖。
- **测试 1:1 镜像**：每个 src 模块都有对应 test 文件，纯逻辑全覆盖。
- **文档配套**：docs/design.md、FAQ.md、gap-analysis.md。

---

## 2. 需要重构的问题（按优先级）

### P1-1 skill.ts ↔ skillquality.ts 运行时循环依赖

**现状**：双向 value import。

- `skill.ts:13` → `import { skillResourceRefs, validateRenderedSkill } from "./skillquality.js"`
- `skillquality.ts:25` → `import { renderSkillMarkdown, skillNameOf } from "./skill.js"`

当前能运行，只因为两边的交叉调用都发生在函数体内（模块初始化完成后才被调用，属惰性求值）。这是**脆弱的巧合**：任何一方把对方引入模块顶层求值（如顶层常量、装饰器、原型扩展）就会 TDZ 崩溃。

**修法**：把渲染职责下沉到新模块 `src/skill-render.ts`：

- `renderSkillMarkdown(entry)`（自 skill.ts 移入）
- `skillNameOf(id)`（自 skill.ts 移入）
- `oneLine` 私有辅助

依赖方向变为单向：`skill → skill-render`、`skillquality → skill-render`，两个模块互不引用。

**涉及文件**：src/skill.ts、src/skillquality.ts、新增 src/skill-render.ts；测试保持原模块名（skill.test.ts / skillquality.test.ts 只需调整 import 来源）。

### P1-2 LLM 结构化输出调用模式重复 3 份

**现状**：三个模块各自实现一遍完全同构的"流式文本调用"：

- `review.ts:124-178`（reviewAutoRefine，~55 行）
- `planner.ts:103-163`（planWithLlm，~60 行）
- `wrapup.ts:507-572`（assessLocalEntries，~65 行）

每份都包含：provider/model 校验 → `BlockAssembler` → `ctx.llm.stream` → finish 状态机检查（error/aborted/max-tokens）→ text block 提取 → 空文本检查。**约 120 行重复代码**，且错误语义三处各写各的（错误前缀不同、max-tokens 检查有细微差异）。

**修法**：新增 `src/llm-text.ts`：

```ts
export interface StreamTextOptions {
  provider: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function streamText(ctx: Context, opts: StreamTextOptions): Promise<string>
```

- 统一抛出语义化错误（`no provider/model route`、`call failed`、`aborted`、`max-tokens`、`no text output`）
- 保留 `reasoningEffort: ReasoningEffortId("off")` 与 `source: { kind: "plugin", plugin: "dsh-continual-evolve" }` 为默认
- 三个调用方只保留各自 system prompt / user prompt / JSON 解析

**涉及文件**：新增 src/llm-text.ts；改写 review.ts、planner.ts、wrapup.ts；新增 llm-text 的测试（可用 fake ctx.llm 覆盖 finish 各分支）。

### P2-1 Config schema 与手写接口双份维护

**现状**：`index.ts:31-71` 的 z schema 与 `index.ts:74-97` 的手写 `EvolveConfig` 接口逐字段重复（含注释重复）。schema 新增/改字段时必须同步改接口，否则编译期才能暴露漂移（且已存在：schema 里 `fateIntervalTurns` 无默认值，接口里也无——默认逻辑散落在 apply 调用处）。

**修法**：用 zod 推断消重：

```ts
export type EvolveConfig = Partial<z.infer<typeof Config>>;
```

- `z.infer<typeof Config>` 全字段必填（schema 中 `baseDir`/`skillsDir`/`rubricKey` 为必填），`Partial<...>` 还原"可省略"语义，与现状接口行为一致
- 删除手写接口的字段注释（schema 注释保留为唯一真源）
- 验证：`pnpm typecheck` + apply/command 相关测试

**涉及文件**：src/index.ts。

### P2-2 command.ts 860 行 god file

**现状**：单文件包含：tokenizer + 大 switch 分发（~200 行）+ `executeGoalCommand`（~290 行）+ `executeBenchmarkCommand` + `executeMountCommand` + `executeWrapupCommand` + import/export/log/archive 内联处理 + 渲染辅助。

**修法**：按子命令域拆分，dispatcher 只留 switch：

| 迁移目标 | 迁出内容 |
|---|---|
| `src/goal.ts` | `executeGoalCommand`（goal 命令域逻辑，goal.ts 已有服务封装） |
| `src/mount.ts` | `executeMountCommand`（mount.ts 已有 load/unload 逻辑） |
| `src/benchmark.ts`（或新建 `src/benchmark-command.ts`） | `executeBenchmarkCommand` 及 `failedTextOf` 等专属辅助 |
| `src/wrapup.ts` | `executeWrapupCommand` |
| `command.ts` 保留 | `tokenizeEvolveInput` / `stripAngleBrackets` / `findEntryById` / switch 分发 / list/history/rollback/archive/log/export/import |

每步拆分后跑 `pnpm typecheck && pnpm test`，command.test.ts 断言不变则行为未动。

### P3-1 服务访问 cast 重复

**现状**：`(ctx as unknown as { userQuestions?: QuestionService }).userQuestions` 出现 4 次：approval.ts:28、auto.ts:390、command.ts:553、fate.ts:163。

**修法**：仿照 `goalServiceOf`（goal.ts:53），在 approval.ts 导出 `questionServiceOf(ctx)`，四处替换。

### P3-2 auto.ts 死代码 + 注释矛盾

**现状**：
- `advanceGateState`（auto.ts:94）导出但**生产路径不使用**（只有 test/auto.test.ts 引用）；`agent/status` 监听器实际靠 turn-stopping 计数。
- auto.ts:88-93 的注释声称"用 agent/status transitions alone 计数、turn-stopping 不可靠"，与 121-123 行注释及实现（turn-stopping 计数）**直接矛盾**——文档漂移。

**修法**：删除 `advanceGateState` 及对应测试；统一为 turn-stopping 计数语义，重写头部注释；或反向——若确认 status 计数更可靠，则改实现并让 turn-stopping 不再计数。**决策前需确认当前计数来源的实际行为**（建议保留现有实现，只修注释与删死代码）。

### P3-3 死导出

**现状**（仅定义处引用，外部无使用）：
- `eventToLine`（render.ts:98）
- `restoreEntry`（rollback.ts:70）
- `loadStateFile`（store.ts:84）

**修法**：删除导出（内部使用则改 private）。`restoreEntry` 若被 rollback.ts 内部用则降为函数声明即可。

### P3-4 skillquality.ts 三职责混杂 + 命名易混

**现状**：
- `skillquality.ts` 同时承担：(a) skill-creator 模板读取（readSkillCreatorTemplate）；(b) 内置质量指南文本（BUILTIN_SKILL_QUALITY_GUIDE / skillQualityGuide）；(c) 机械校验（frontmatter 校验、内容校验、资源引用扫描）。三者的变更频率与测试维度都不同。
- `plan.ts`（JSON 提取/解析）与 `planner.ts`（LLM 规划）文件名几乎同形，误导读者。

**修法**（可选，低优先级）：
- (c) 拆到 `src/frontmatter.ts`（含 parseMiniYaml 等），(a)(b) 留在 skillquality.ts
- `plan.ts` 改名 `src/proposal-parse.ts`（或 `json-parse.ts`），同步改 4 处 import（planner/review/wrapup）

### P3-5 service.ts 重导出 storePaths

**现状**：`service.ts:69` `export { storePaths }`，让 command.ts 等表层模块绕开门面语义直接触达 store 路径层。

**修法**：表层模块直接 `from "./store.js"` 导入，删去重导出。轻微层次净化。

---

## 3. 明确不做的（保留现状）

- 不引入依赖注入框架、不抽领域层基类——插件规模不需要
- 不合并 benchmark 子系统（benchmark/rubric/score/evaluate/pool 边界清晰）
- 不改 `fate.ts ↔ auto.ts` 的类型级循环（`import type` 仅类型引用，编译期擦除，无运行时风险）
- 不拆 `index.ts` 的 apply 装配逻辑（177 行，尚在可读范围）
- 不动存储格式与协议（schema=1 兼容）

---

## 4. 执行顺序与验收

1. P1-1 → P1-2 → P2-1 → P2-2 → P3-1~P3-5（每步独立提交，行为不变）
2. 每步验收：`pnpm typecheck && pnpm test && pnpm lint`
3. 总验收：`dsh plugin --profile web add dsh-continual-evolve` 的现有部署无需重装（仅代码内部重组，包导出面不变：`lib/index.js`、`lib/types.js`、`cordis.patch.yml` 均不动）

---

## 5. 附带观察（非阻塞）

- rc.7 兼容性已核查：插件的 `^0.1.0-rc.6` peerDeps 满足 rc.7；三个新功能（插件设置卡片 / Codex 子代理后台 Job / MCP-ACP 图片附件）对本插件均无影响（无设置 UI、无产品工具行、无图片路径）。见会话记录 2026-08-18。