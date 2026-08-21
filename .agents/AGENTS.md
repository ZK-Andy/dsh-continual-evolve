# AGENTS.md — .agents/（AI 协作层）

本子树的专属规则：**AI 协作机制本身**（技能、ADR、模板）。不重复根文件内容。

## 技能

- `.agents/skills/` 由 DSH 自动发现（skill 工具按需加载），无需注册。
- 技能为 deepseek-harness 原版；**正文不改方法论**——本项目要加的专属规则写进上层 AGENTS.md 或本文件。
- 用不上的技能不会触发，零干扰；首版稳定后按证据剪枝（触发过 ≥1 次、或其规则被文档/评审引用者保留）。

## ADR（Agent Notes）

- 路径：`.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-<topic>.md`。
- class 封闭集合：`feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`。
- 状态即目录：`proposed` → `implemented`（改 Status + 移目录）→ `archived`（冻结，只插 `Archived:` 行）。
- implemented 笔记用现在时，**禁止** `## Proposal`/`## Plan`/`## Acceptance criteria`；强制 `## Alternatives considered`。
- 双语暂不启用：正文中文单语（开启时恢复 `.zh.md` + 配对机制）。

## 出处声明（MIT）

- `.agents/skills/` 全部技能：© deepseek-ai，MIT License，来自 `deepseek-ai/deepseek-harness`（https://github.com/deepseek-ai/deepseek-harness）。2026-08-22 自 devops-template 逐字原样拷贝（与上游一致，已 diff 验证）。
- `.agents/notes` 骨架、`templates/` 骨架、门禁脚本：来自 devops-template（提炼自 deepseek-harness，MIT）。搬运保留出处。
