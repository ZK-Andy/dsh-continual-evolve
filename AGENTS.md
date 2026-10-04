# dsh-continual-evolve — 项目规则

DeepSeek Harness 的工作区记忆插件：每个工作区一个纯 markdown 记忆库（`<workspace>/.evolve/memory/`），会话开局注入索引，模型用原生文件读写工具直接使用。TypeScript npm 库，以 cordis 插件形态挂载（`cordis.patch.yml`）。

## 协作模式（AI + 人）

- 本仓库由 coding agent（DeepSeek Harness）+ 人协作开发；agent 先读本文件与本仓库技能再动手。
- 每次动手前说清变更范围；**非平凡变更必须同变更携带 Agent Note（ADR）**（见 `.agents/notes/README.md`）。改行为、架构、跨模块契约、状态/wire 格式、流程者皆属非平凡；纯机械、局部编辑豁免。
- 讨论与取舍落成 ADR，不散在会话里；ADR 强制 `## Alternatives considered`。

## 流程卡（索引）

会话与开发流程按卡执行：

- [session-modes](.agents/workflows/session-modes.md)——模式契约：讨论/调研/实现/发布的许可边界；**会话开场必须声明模式**
- [session-open](.agents/workflows/session-open.md) / [session-close](.agents/workflows/session-close.md)——会话开、收尾检查单
- [feature-flow](.agents/workflows/feature-flow.md) / [release-flow](.agents/workflows/release-flow.md)——开发与发版主链路

## 文档纪律

- **每个事实只有一个家**：rationale → Agent Notes；使用方法 → README/docs；规则 → 本文件 + 链接。
- durable 文档**写当前状态，不写变更历史**（"previously / now / no longer / renamed" 是 slop）。
- ADR 路径即元数据：`{lifecycle}/{class}/yyyy-mm-dd-<topic>.md`；`rejected` 仅当理由能防重蹈覆辙才保留；`archived` 永久冻结。
- 相对 Markdown 链接 + 机器可校验；禁裸文件名引用。

## 编码约定（TypeScript）

- 完整规范：[docs/coding-standard.md](docs/coding-standard.md)（编码）与 [docs/architecture-standard.md](docs/architecture-standard.md)（分层/预算/host 边界）。
- 红线：**fail loud**；行为级变更必须配套回归测试（vitest）；构建产物只进 `lib/`、源码只在 `src/`。

## GitHub 调研纪律（强制）

调研 GitHub 项目一律 gh CLI；禁以 web 检索开局、禁全量克隆作首选。六步配方见 [.agents/workflows/github-research.md](.agents/workflows/github-research.md)。

## 检索通道路由（强制）

web 检索优先 anysearch 纵向面（zone/tag/params 富参数）；GitHub 归 gh；无纵向诉求的快查可用内置 web_search。路由表见 [.agents/workflows/search-routing.md](.agents/workflows/search-routing.md)。

## Git 纪律

- 改写历史必须 `--force-with-lease=<branch>:<observed-oid>`；**raw `--force` 永远禁止**；改写后重新审计评审状态。
- push 前最小证据：按 diff 面选最窄检查（先用 `scripts/change-scope.sh`）；hooks 只做快检查，CI 拥有穷尽矩阵（node 22/24）。

## 质量门（当前可执行）

```sh
pnpm typecheck && pnpm lint && pnpm test   # TS 工程链（vitest + oxlint）
pnpm check:docs                            # 文档门禁（tsx run-gates：adr/预算/链接/治理）
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
