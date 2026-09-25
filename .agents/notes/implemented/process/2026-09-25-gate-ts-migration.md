# Agent Note: 门禁 TS 化与覆盖率语义对齐 DSH

Status: implemented

> 放置路径：`.agents/notes/implemented/process/2026-09-25-gate-ts-migration.md`

## Problem

本仓是 TS 项目，但四个文档门禁曾是 Python（2026-08-22 从 devops-template 原样搬运的遗留），而 DSH 上游全部文档门禁走 `tsx scripts/*.ts`（`run-gates.ts` 聚合）。语言栈分裂导致新人困惑、与上游写法不可复用。

覆盖率语义同样不对齐：DSH 为逐文件 100（`perFile: true` + 未覆盖 `path:line:col` 定位器 + 重型套件豁免）；本仓曾为全仓平均（lines/functions/statements 75、branches 65），门槛不防单文件腐烂，也不定位。

## Decision

- 门禁 TS 化：四个门禁实现为 `scripts/verify-*.ts`（行为与原 py 逐项等价，含 node_modules/skills 排除等本仓适配），`scripts/run-gates.ts` 聚合（`docs` / `all`）；`package.json` 含 `tsx` devDep 与 `check:docs` / `check:governance` 脚本；`.githooks/pre-commit` / `pre-push` / `ci.yml` 走 TS 入口；py 文件删除，git 历史保留。
- 覆盖率 DSH 形：`vitest.config.ts` 用 `perFile: true`（语义与 DSH 同形），阈值按水位线锁定单文件下限（lines/statements 78、functions/branches 65）；`tsconfig.scripts.json` 把 `scripts/**/*.ts` 纳入 `pnpm typecheck`。
- 分两步走：本轮 gate 形状 + 水位线；逐文件 100 为后续专项（当前低洼：`tool.ts` / `wrapup-command.ts` 函数覆盖、`evaluate.ts` 分支、`mount.ts` 全项）。

## Alternatives considered

- **保留 Python 门禁**：零迁移成本，但语言栈继续分裂，且无法复用上游 `run-gates` / 定位器写法。落败。
- **本轮一步到位逐文件 100**：约 20 个文件需补测（含 auto/command/evaluate/mount 等低洼），工作量超出单轮，且容易为凑数写弱断言。改为水位线 + 路线图。落败。
- **用 node 原生 strip-types 代替 tsx**：Node 版本相关行为差异大，DSH 标准即 tsx，跟随上游更稳。落败。

## Consequences

- 收益：单语言栈（TS + tsx），与 DSH 门禁写法同形；per-file 水位线防止单文件腐烂；scripts 纳入 typecheck。
- 代价：tsx 新增 devDep（dev-only，不进发布产物）；CI 文档门禁需 install 后运行（顺序已调整）。
- 遗留：逐文件 100 路线图；未覆盖定位器（DSH `coverage-uncovered-locations.cjs` 同款）随后补。

## Testing

- py/ts 双跑对照：33 notes、68 links、预算三文件结论逐字节一致后删 py。
- `pnpm check:docs` 全绿；per-file 水位线下 `pnpm test:coverage` 全绿（795 测试 / 48 文件）；`pnpm typecheck`（含 scripts）/lint 0 警告。
