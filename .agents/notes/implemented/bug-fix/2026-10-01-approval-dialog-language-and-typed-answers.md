# Agent Note: 审批弹窗语言链修复 + 接受打字回复

Status: implemented

## Problem

2026-10-01 在 dotnet-desktop（v0.10.5）真实使用中一次 `evolve_add global` 暴露两个缺陷：

**① 审批弹窗是英文。** `requestScopeApproval` 的语言取 `lang ?? resolveDialogLanguage(ctx)`，而 `resolveDialogLanguage` **只读持久 locale 偏好、无轨迹层**（`copy.ts` 的设计注释："Dialogs carry no trajectory text"）。同时四个调用点（`tool.ts` ×3、`command.ts` plan、`wrapup-command.ts`、`memory-agent.ts`）**无一处传 `lang`** → 配置项 `recordLanguage` 对审批弹窗**完全无效**（只有 fate / skill consult / wrapup 归档确认走了各自的语言链）。持久偏好的来源是 DSH settings 文档 `<profile.home>/settings.yaml`，而 dotnet-desktop 下**该文件不存在**（全盘核实）→ `durableLocalePreference` 返回 `undefined` → 兜底 `en`。用户 profile patch 里的 `dsh-client-locale: preference: zh` 是**部署默认值**，与 settings 文档的**用户偏好**不是同一来源：UI 走前者，插件读后者。

**② 在输入框里打字回复被判空。** 上游契约（`dsh-user-questions` 的 `AskUserQuestionAnswerItem`）是 `selected: string[]` **加 `custom?: string`（自由文本 "Other" 回答）**；输入框文字落进 `custom`，`selected` 为 `[]`，而解析只认 `selected` 里的 `"批准"`/`"Approve"` → 抛 `evolution approval returned an invalid decision: []`。这本身是 FAQ #13 的刻意 fail-loud（丢失/歧义回答绝不记为持久拒绝），但错误文案没有告诉用户"必须点选项按钮"，实际观感是"系统坏了"。

## Decision

四项同变更落地：

- **A（配置穿透）**：`ToolGateOptions` / `CommandRuntimeOptions` / `ApplyMemoryProposalOptions` / `executeWrapupCommand` 各加 `recordLanguage?: RecordLanguagePreference`，由 `index.ts` 从 `config.recordLanguage` 注入并逐层转发到 `requireGlobalApproval` / `requestScopeApproval`。
- **B（完整语言链）**：`requestScopeApproval` 的语言改为 `normalizeRecordLanguage(configured) ?? resolveRecordLanguage({ ctx, trajectoryText: recentUserText(agent) })` —— 即**与记录语言同一条链**：显式配置 → 持久偏好 → **会话自身最近用户文本** → `en`。审批弹窗由工具调用/命令触发，手里本就有 agent 与会话，轨迹层可用；`auto` 视为延后（不是语言）。
- **C（打字可用）**：`selected` 为空时读 `custom`，经归一化（去首尾空白、引号、尾随标点、尾随"吧/了"，小写）后**精确匹配**标签才作数（`批准`/`approve`、`拒绝`/`decline`）；仍拒绝模糊文本。
- **D（可操作错误）**：空回答/不匹配时抛 `evolution approval needs one clicked option (批准/Approve or 拒绝/Decline) — a typed reply cannot serve as a decision`。

同一缺陷家族的 `wrapup` 归档确认弹窗（`wrapupArchiveCopy` 原走 `resolveDialogLanguage(ctx)`）一并纳入同一条链。

## Alternatives considered

- **只写文档让用户点按钮，不改代码**：用户已实际踩到且错误文案误导（"invalid decision: []" 读起来像系统故障），把可用性缺陷留成文档债，拒绝。
- **给 `resolveDialogLanguage` 全局加轨迹层**：fate / skill consult 等路径常常没有 agent（它们有自己的链，且部分调用点刻意无轨迹），改全局会连带改变这些路径的行为，拒绝。改为只在审批调用点用完整链。
- **打字用子串匹配（"我批准"/"批准写入"也算）**：会误读 **"不批准"** 为批准——误读一次决策的代价远大于让用户点一下按钮，拒绝。归一化后精确匹配，其余抛错。
- **`custom` 非空即视为批准**：同上且更危险，拒绝。
- **把 durable 偏好直接写进 profile 的 settings.yaml 解痛**：治标不治本（配置项对弹窗仍然无效），且要写 workspace 之外的文件；正规路径是 GUI 语言设置写入该文档，代码侧仍需修链，拒绝。
- **把标签改成双语同显（"批准/Approve"）**：上游解析按字面标签匹配，改标签会破坏既有解析与测试，拒绝。
- **保持空回答即抛错但换措辞**：只解决观感，不解决"打字没用"这件事本身，拒绝。

## Consequences

- 审批弹窗语言与记录语言**同一条链**，行为一致：中文用户即使没有任何配置、settings 文档为空，也会因会话文本得到中文弹窗；显式 `recordLanguage: en` 仍可强制英文。
- 打字回复在**精确等于标签**时可作决策；其余情况仍 fail-loud 并给出可操作提示——"丢失/歧义回答不算持久拒绝"这条不变量不变。
- 测试：新增 `test/approval.test.ts`（13 例：打字接受/拒绝/否定与歧义拒收/标签不变/语言链五档）；全套 **60 文件 / 1110 测试**。
- `resolveDialogLanguage` 保留，作为 fate / auto 在未显式给语言时的兜底（那些路径自带链），行为未变。
- 已知边界：`custom` 只做精确匹配，因此"我批准"这类口语化回复仍会被拒（提示用户点按钮）。若日后要放宽，必须先解决否定词（"不批准"）的判别，否则不放宽。
