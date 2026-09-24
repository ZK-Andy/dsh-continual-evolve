# Agent Note: github-release-notes

Status: implemented

## Problem

发版只有 npm 产物 + tag，没有 GitHub Release：更新内容散在 commit message 里，无双语、无按条目作者、无版本间 compare 入口。对标上游 `deepseek-ai/deepseek-harness`（`dsh-v0.1.7-alpha.1` 版式）后缺三件：`[中文|English]` 双语锚点对照、分组小节、每条 `@作者` + 结尾 Full Changelog 链接。

## Decision

每个 tag 配一个 GitHub Release，版式抄 DSH 并裁到单包体量：

- Body 结构：`[中文](#cn-vX.Y.Z) | [English](#en-vX.Y.Z)` 双语锚点 → 中文分组小节（新功能/问题修复/其他改动）→ 英文分组小节（Features/Bug Fixes/Chores）→ `Full Changelog` compare 链接 + npm 链接。
- 每条目后缀作者（`(@name)`，发布时换成 `@handle`）。作者来自 `git log`，与 DSH 从 PR 收集同源。
- 半自动草稿：`scripts/draft-release-notes.sh [prev-tag] [new-version]` 按 `feat/fix/*` 前缀分组，输出 `releases/vX.Y.Z.md` 草稿（含 commit hash 溯源注释 + 英文待润色标记），人 polish 后 `gh release create` 发布。全自动写不好双语，DSH 自己也是手写的。
- Notes 文件进仓（`releases/`），与 tag 同审计；`release-flow.md` 在 tag 推送后、npm 发布前插入建 Release 步骤，核验项加一条。

## Alternatives considered

- **全自动生成英文（机翻直发）**：双语质量不可控，发版 notes 是对外门面，机翻 artifacts 会长期留在远端。否决，英文区保留 TODO 标记人工过一遍。
- **用 GitHub auto-generated notes**：按 PR 分组、无双语、无主题分组，与 DSH 版式差太远，且我们是直推 main、无 PR 纪律。否决。
- **照抄 DSH 全套（environment 审批 + 手动 dispatch + 多包同版本）**：那是几百人 monorepo 的 ceremony，单包 + 1~2 人是纯 overhead。只取版式三件，不取流程。
- **CHANGELOG.md 常驻文件**：与 Release notes 双源 Rival；单一事实源应是 `releases/vX.Y.Z.md`（随 tag 审计），CHANGELOG 靠 Release 页面聚合。否决常驻文件。

## Consequences

- 发版多两步（跑脚本 + polish + `gh release create`），换来可传播的更新页。
- 首个 Release 之前无 prev-tag 时脚本取全历史，属一次性行为。
- `verify-md-links.py` 覆盖 `releases/`（相对链接纪律不变；compare/npm 用绝对链接）。
