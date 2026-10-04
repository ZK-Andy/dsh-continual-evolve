# TS 编码规范

> 与根 `AGENTS.md` 编码约定同源；本文件是完整版，AGENTS.md 只留指针与红线。
> 结构与规模约束（分层/预算/边界）在 [`architecture-standard.md`](./architecture-standard.md)，两文不重复。

## 1. 编译与模块

- `tsconfig.json` 严格集维持：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`noUnusedLocals/Parameters`。任何放宽必须 ADR。
- ESM 单构建：`tsc` 产 `lib/`，内部 import 带 `.js` 后缀；禁引入第二构建器/打包器。
- target/lib 跟随 host 运行时（现 es2024）。

## 2. 类型

- 禁 `any`（含 `as any`）；需要逃生口用 `unknown` + 收窄，并注释为何类型系统覆盖不到。
- 跨模块传递的 ID 用 Branded 类型；禁裸 `string` 跨层。
- `exactOptionalPropertyTypes` 下可选传参用条件展开：`...(x !== undefined ? { x } : {})`——禁传显式 `undefined`。
- schemastery schema DSL 的 `required` 写法遵循 FAQ #2（属性级 `required: true`；mount 裸 register 例外用根级数组）。
- 配置类型从 schema 派生（`Partial<Schemastery.TypeT<typeof Config>>`），禁手写平行类型。

## 3. 错误处理

- **fail loud**：缺失引用、误配置绝不静默跳过。
- `catch` 必须命名它吞掉什么；`try` 只包一个语句；空 `catch {}` 禁止。
- 领域错误用具名 Error 类（如 `EvolutionApplyPostCommitError` 携带批次数据）；错误信息必须可操作。
- **审计语义不变**：失败不推进 cursor、不静默重试、必写 `reviews.jsonl`；"用户没回答"≠"用户拒绝"。

## 4. 命名与组织

- 文件 kebab-case、一名一责；测试与被测文件同名 1:1（`foo.ts` ↔ `test/foo.test.ts`）；错误路径测试用 `foo-onerror.test.ts`。
- 类型 PascalCase；模块级常量 UPPER_SNAKE；导出函数动词开头；布尔 `is/has/should`。
- 注释与标识符英文；交付文档（docs/README/ADR/HANDOFF）中文正文。注释只写代码表达不了的约束（上游事实、不变量、坑），不写流水账。
- 导出函数与被 host 调用的钩子带 TSDoc `@param/@returns/@throws`。

## 5. 配置与日志

- 可调参数进 `index.ts` 的 schemastery `Config`，禁硬编码魔法数；协议常量与安全不变量（schema version、section 命名、审计字段名）保持固定。
- 每个配置键必须在 README 配置表有对应行；键删除与 README 删除同一提交。
- 日志走 `ctx.logger("continual-evolve")` + `logfile.ts` 文件 exporter；禁 `console.*`。
- 直调 LLM 的 token 记账唯一入口 `token-usage.ts`；新增 LLM 调用点必须记账。
- 机械化判断（gate/skip/declined）写 `reviews.jsonl`；人类可读投影走 `projection.ts`，两套账不混用。

## 6. 测试

- vitest；行为级变更必须配套回归测试；覆盖边界、错误路径、事件顺序、并发。
- mock 只用于昂贵/非确定性边界：LLM 调用、时钟、随机。文件系统用真实 tmp 目录。
- 测试标题写行为不写实现。
- 删除功能时其测试同版本删除；保留功能不得靠删测试转绿。

## 7. 提交与治理

- Conventional Commits；非平凡变更同变更携带 ADR（`## Alternatives considered` 强制）。
- durable 文档写当前状态不写变更史；每个事实只有一个家。
- `pnpm typecheck && pnpm lint && pnpm test` 三关 + `run-gates` 文档门禁全绿才算完成。
