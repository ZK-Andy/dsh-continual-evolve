# Agent Note: 提取 Prompt 具体性规则（防宽泛记忆）

Status: implemented

## Problem

后台 Memory Agent 从中文会话提取出 `user-primary-language-chinese`（"用户主要用中文沟通"）并请求 global 审批：现象描述正确，但宽泛到无法指导下一次行动。根因是提取 Prompt 只有抽象规则（一条事实、memoryType、Why/How），零 few-shot 示例——模型默认输出宽泛概括。用户以中文为主，此类低质提取会反复出现。

## Decision

- 对照 ZCode `persistent-memory-prompt.ts` 找差异：ZCode 无宽泛问题的结构原因是① 每 type 配 2–3 个输入→输出示例，示范"具体到什么粒度"（如 Go 十年经验 + React 新手→"前端解释套后端类比"）；② `description` 字段要求"供未来 relevance 判断，必须具体"；③ 显式 surprising-or-non-obvious 过滤（"只存意外的、非显而易见的"）。其 `extraction.ts` 并无机械质量门，Prompt 即防线。
- 本仓 Prompt 追加三行（保持后台 loop 的 token 节俭，不搬全模板）：可行动具体性规则（"告诉下个会话做什么，而非总结发生了什么"）、surprising-or-non-obvious 过滤、两个中英对照粒度示例（中文例正好是本次误报的 vague→sharp 改写；desktop 插件例用本仓真实 gotcha 做域内锚点）。
- 回归：`test/memory-agent.test.ts` 新增 Prompt 契约两例（排除清单锁定 + 具体性规则与示例锁定），防后续 Prompt 精简时误删。

## Alternatives considered

- **校验层强制具体性（长度下限/Why-How 扩到 user）**：具体性不可机械判定（长废话仍宽泛）；user 类型补 Why/How 会误伤合法短记忆。Prompt 层是 ZCode 验证过的解，拒绝。
- **照搬 ZCode 全模板（含 scope guidance、link、verify 章节）**：后台 loop 每 turn 都发 system prompt，全模板数百 token 是常驻成本；且 link/verify 章节面向文件型 agent，与本仓闭集工具不兼容。只取具体性三件套，拒绝全搬。
- **benchmark 加宽泛维度**：宽泛无机械定义（短语命中测不出"泛"）；事后度量不如事前示例，拒绝。
- **直接删已提的宽泛条**：那是运行时单条数据的去留，用户点拒绝即解决；本次修的是不再产生，拒绝混为一谈。

## Consequences

- 提取 token 每 turn 增加约百量级；误报类宽泛提案应显著减少，效果待真实会话观察（OBSERVATION 记忆质量项）。
- 仍可能漏网：Prompt 是软约束，极端宽泛可过；审批人（用户）是最后一道门。
