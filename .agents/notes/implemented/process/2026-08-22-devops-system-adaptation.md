# Agent Note: 采纳 deepseek 开发协作体系（技能/ADR/门禁）

Status: implemented

## Problem

本仓库此前只有技术栈工程层（vitest/oxlint/tsc 的 CI 矩阵、Issue 模板），没有 AI 协作层：无 agent 规则文件、无可复用的评审/push 纪律技能、无决策记录系统。随着 agent 参与度提高，取舍散落在会话里无法审计，评审与 push 前检查靠自觉。

## Decision

本仓库采用 deepseek-ai/deepseek-harness 提炼的开发协作体系（经 devops-template 搬运，参照 dotnet-deepseek-harness-desktop 已验证形态），包含：

- 规则分层：根 `AGENTS.md`（项目规则 + 质量门命令 + 字数预算表）、`.agents/AGENTS.md`（AI 协作子树规则 + MIT 出处声明），DSH 自动加载。
- 技能：`.agents/skills/` 全量 11 个技能，逐字原样拷贝（与上游逐字节一致，已 diff 验证），正文不改方法论。
- 决策记录：`.agents/notes/{proposed,implemented,archived,rejected}/<class>/` 六类封闭 class；非平凡变更必须同变更携带 ADR，强制 `## Alternatives considered`。
- 门禁：`scripts/verify-{adr-format,doc-budgets,md-links}.py` + `doc-budgets.manifest.json` + `change-scope.sh` + `setup-hooks.sh`；`.githooks/pre-commit` 做快检、`pre-push` 按 diff 面（src/test 有变更才跑 TS 工程链）做最小证据。
- CI：ci.yml 在 Checkout 后跑三个文档门禁；新增提示级 `governance.yml` 校验 Issue/PR 输入；Issue 模板补 Owner/Priority/Class 治理字段并新增 chore/test_feedback/config。
- `verify-md-links.py` 相对模板增加一处适配：排除 `node_modules/`（第三方依赖内容的链接不属本仓库责任，与默认排除 `skills/` 同理）。

## Alternatives considered

- **技能按路径映射表改写**（把技能内的 deepseek 仓库引用替换为本项目对应物）再入库。落败原因：破坏与上游的逐字节一致性，出处声明失据，且未触发的技能改写纯属投机成本；参照 dotnet 项目先全带原样、后按证据剪枝的实践。
- **Issue 模板整体替换为 dotnet 版**。落败原因：现有 bug_report/feature_request 含插件领域字段（DSH 版本/安装方式/profile），替换会丢失排障信息；改为保留领域字段、仅顶部补治理字段的最小合并。
- **门禁只进 hooks 不进 CI**。落败原因：hooks 可绕过且本地环境不一，穷尽矩阵必须由 CI 拥有；hooks 只承担快检。

## Consequences

换来：决策可审计（ADR 与变更同提交）、评审与 push 有机器强制下限、agent 行为有仓库级规则约束。付出：文档改动需过三道门禁（预算/死链/ADR 格式）；11 个技能中暂用不到者占仓库体积但零运行时干扰，待首版稳定后按触发证据剪枝。
