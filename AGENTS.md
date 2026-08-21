# dsh-continual-evolve — 项目规则

DeepSeek Harness 的持续自我进化插件：从会话轨迹中提炼**版本化、可审计、可回滚**的 harness 状态（prompt notes / memories / skills / subagent specs）。TypeScript npm 库，以 cordis 插件形态挂载（`cordis.patch.yml`）。

## 协作模式（AI + 人）

- 本仓库由 coding agent（DeepSeek Harness）+ 人协作开发；agent 先读本文件与本仓库技能再动手。
- 每次动手前说清变更范围；**非平凡变更必须同变更携带 Agent Note（ADR）**（见 `.agents/notes/README.md`）。改行为、架构、跨模块契约、状态/wire 格式、流程者皆属非平凡；纯机械、局部编辑豁免。
- 讨论与取舍落成 ADR，不散在会话里；ADR 强制 `## Alternatives considered`。

## 文档纪律

- **每个事实只有一个家**：rationale → Agent Notes；使用方法 → README/docs；规则 → 本文件 + 链接。
- durable 文档**写当前状态，不写变更历史**（"previously / now / no longer / renamed" 是 slop）。
- ADR 路径即元数据：`{lifecycle}/{class}/yyyy-mm-dd-<topic>.md`；`rejected` 仅当理由能防重蹈覆辙才保留；`archived` 永久冻结。
- 相对 Markdown 链接 + 机器可校验；禁裸文件名引用。

## 编码约定（TypeScript）

- **fail loud**：缺失引用、误配置绝不静默跳过；空 `catch` 必须命名它吞掉什么；`try` 只包一个语句。
- 公共 API 带 TSDoc 契约（`@param/@returns/@throws`）；跨界 ID 用 Branded 类型，禁裸 `string` 跨模块传递。
- 可调参数进 schemastery 配置模型，禁止硬编码；协议常量与安全不变量保持固定。
- 测试：vitest（`pnpm test`）；覆盖边界、错误路径、事件顺序、并发；**行为级变更必须配套回归测试**；mock 只用于昂贵/非确定性边界（LLM 调用、时钟）。
- 构建产物只进 `lib/`（tsc），源码只在 `src/`；不手改 `lib/`。

## Git 纪律

- 改写历史必须 `--force-with-lease=<branch>:<observed-oid>`；**raw `--force` 永远禁止**；改写后重新审计评审状态。
- push 前最小证据：按 diff 面选最窄检查（先用 `scripts/change-scope.sh`）；hooks 只做快检查，CI 拥有穷尽矩阵（node 22/24）。

## 质量门（当前可执行）

```sh
pnpm typecheck && pnpm lint && pnpm test   # TS 工程链（vitest + oxlint）
python3 scripts/verify-adr-format.py       # ADR 头/骨架/状态-目录一致性
python3 scripts/verify-doc-budgets.py --manifest scripts/doc-budgets.manifest.json  # 字数预算
python3 scripts/verify-md-links.py         # 相对链接/锚点（skills/ 排除）
scripts/change-scope.sh [<base> <head>]    # 变更范围（评审/push 前置）
```

## 字数预算

| 文件 | 上限 |
|---|---|
| 本文件（AGENTS.md） | ≤ 800 词 |
| .agents/AGENTS.md | ≤ 300 词 |
| .agents/notes/README.md | ≤ 800 词 |

超限：迁移到其他层（留一行链接）→ 精简 → 才允许提额度（PR 说明理由）。

## 参考

- 协作体系与技能出处见 `.agents/AGENTS.md`；全部技能源自 `deepseek-ai/deepseek-harness`（MIT）。
- 插件设计背景见 `docs/design.md` 与 `docs/research/`。
