# Agent Note: HANDOFF 交接家庭拆分治理与机器门禁

Status: implemented

## Problem

工作区根 `/mnt/work/work/HANDOFF.md` 是单项目工作区的唯一交接文档，长期单文件无界追加：到 2026-09-30 已达 103KB，顶部追加记录 62 条、待办整节停在 v0.7.x 时代与实现事实脱节。两个结构性痛点：① **新会话不知道它存在**——会话常从工作区根启动，而根目录没有 `AGENTS.md`，没有任何自动加载物指向 HANDOFF（仓库内的 session-open 卡虽写了路径，但要 cwd 进入仓库读卡后才可见）；② **无机器约束**——窗口长度、条目尺寸、待办预算全靠 agent 自觉遵守 session-close 卡，没有任何脚本在越界时 fail loud。

同构问题在 `dotnet-deepseek-harness-desktop` 已用"HANDOFF 家庭拆分治理"（其 ADR `2026-08-31-handoff-split-governance` + `todos-cold-archive`）解决并被验证：入口滚动窗有界、行动区独立、越窗归档、门禁机检。本仓照此治理，按工作区拓扑适配。

## Decision

HANDOFF 家庭三件制，全部位于工作区根（仓库外，本地工作文档不入 git）：

- `HANDOFF.md`——唯一入口：稳定区（项目是什么/位置/当前状态/待办指针/关键 Gotchas/开始步骤）+「交接更新记录」滚动摘要窗（≤12 条、每条 ≤260 字、格式 `日期｜类型｜commit/ADR 指针｜一句话结论`）。durable 结论只落 ADR/docs/README，滚动窗只留指针。
- `HANDOFF-todos.md`——行动区（跨会话遗留的唯一落点）：`[ ]` ≤16 条且每条 ≤340 字；`[x]` 压缩为一行指针 ≤220 字、近期窗口 ≤24 条；非行动类（封存/观察/被动维护）独立小节，不计 `[ ]` 预算。
- `HANDOFF.archive.md`——冷归档（只读）：滚动窗与待办越窗条目的全文归宿，按时间范围整批移入。

加载锚点：工作区根新增 `AGENTS.md`（ZCode/DSH 进入工作区即自动加载），强制会话开场读 HANDOFF 家庭、收尾走"滚动窗追加 + 待办对账 + 门禁"三步。原 `~/.dsh/skills/session-handoff` 技能已不存在，其职责由该锚点与仓库 session-open/close 卡承接。

机器门禁：`scripts/verify-handoff-structure.py`（自本仓 scripts/ 运行，默认按 `WORKSPACE_ROOT = 仓库父目录` 解析家庭三件；`--self-test` 15 个离线夹具自检）。强制面：必备小节存在、滚动窗条数/字数、待办 `[ ]`/`[x]` 预算与压缩、归档指针双向配对（入口必须指名冷归档；被指名必须存在；存在必须被指名）。工作区文件缺席时跳过（clean-CI 语义，同桌面原版）。接线三处：`run-gates.ts` docs 模式（故 CI `pnpm check:docs` 自动覆盖）、`.githooks/pre-push`、`package.json` `check:handoff`（自测+实检）。session-close 卡同步改写：条目格式化、结论落 durable 家、越窗归档、门禁收尾。

## Alternatives considered

- **照抄 desktop 的按月分卷（journal/ + todos-archive/<月>.md）**：本工作区是单项目低频节奏，归档量远小于桌面仓（其单月卷已达 89 条）；单文件冷归档 + 年内再分卷即可，避免两卷指针的维护面。落败原因：过度设计。
- **把 HANDOFF 家庭搬进仓库内（gitignore 本地工作文档，同桌面仓）**：HANDOFF 同时覆盖仓库外的横切物（OBSERVATION.md、profile 接线、工作区脚本），搬进仓库会把仓库边界外的状态锚进仓库。落败原因：工作区≠仓库，家庭放工作区根语义更真；锚点问题由根 AGENTS.md 解决，不依赖文件位置。
- **把门禁改写成 TS 并入现有四门禁（延续 gate-ts-migration 方向）**：新门禁与桌面原版保持同构（同 Python 同函数面）便于上游修复互搬，且它不进 `tsconfig.scripts` 编译面。落败原因：一致性收益小于移植保真收益；若未来门禁面统一再迁。

## Consequences

滚动窗只保近 9 条摘要（历史全文在冷归档），新会话恢复上下文的读面从 103KB 降到 ~20KB；工作区根 AGENTS.md 使任意入口（含本仓之外启动的会话）都能命中交接家庭。代价：收尾多一道门禁步（已并入 pre-push，无额外手动动作）；工作区根 AGENTS.md 与桌面仓语义不同（它是工作区级、非仓库级），克隆本仓得不到它——session-open 卡内的绝对路径是克隆后仍可达的兜底锚。

## Related

- 上游同构：`dotnet-deepseek-harness-desktop/scripts/verify-handoff-structure.py`（门禁形状来源）与其 ADR `2026-08-31-handoff-split-governance`。
- 本仓 session-open / session-close / session-modes 卡（`.agents/workflows/`）。
