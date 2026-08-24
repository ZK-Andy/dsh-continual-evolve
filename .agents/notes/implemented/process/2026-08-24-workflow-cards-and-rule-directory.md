# Agent Note: workflow-cards-and-rule-directory

Status: implemented

## Problem

开发工作流每次会话凭记忆临场拼装，漂移实例：①会话模式无契约——讨论/实现边界靠默契；②收尾无检查单——提交是否都进了 HANDOFF 交接记录靠自觉对账；③发版链路的坑位（npm publish EROFS 绕过、token 位置、version bump 注意点）散落在 HANDOFF Gotchas 与历史叙事里，每次发版重新翻找拼装；④GitHub 调研与 web 检索通道的选择无明文纪律，只有零散踩坑记录，无常驻约束力。

## Decision

参照 dotnet-deepseek-harness-desktop 已验证形态（其 `implemented/process/2026-08-23-workflow-cards-and-rule-directory`），流程固化三层落地：

1. **模式契约**（session-modes）：讨论 / 调研 / 实现 / 发布四型，各带许可边界与禁区；会话开场必须声明模式，切换须显式，边界争议停问不扩权。
2. **命名流程卡**：`.agents/workflows/` 七张卡——session-open / session-close / feature-flow / release-flow / session-modes 五张核心 + github-research / search-routing 两张纪律卡。内容为活文档，「使用中磨合」迭代，修订随普通提交走。
3. **规则目录化**：根 AGENTS.md 只留一行级强制触发语 + 相对链接（流程卡索引、GitHub 调研纪律、检索通道路由三段）；操作配方全部外链细则文件。

随迁 `scripts/verify-governance.py` 本地快检（与 CI governance.yml 同逻辑），并修正上游缺陷：test_feedback.yml 与 config.yml 同为轻量表单，豁免治理字段检查——上游同场景该脚本长期红着无人修。

本项目适配点（非逐字搬运）：基线命令换 TS 工程链并记录沙箱 pnpm deps-status 的绕过；release-flow 按 npm 发版链重写（token/--cache 参数、EROFS、devDeps 不构成发版理由等坑位入卡）；search-routing 按本环境双通道事实改写——web_search 走 Exa provider（web profile patch），anysearch 为独立工具面，两者并非同一后端（桌面 profile 才是 Provider 级接管形态）；session-close 对齐本仓「HANDOFF 在工作区根、仓库内应零未跟踪」的布局。

## Alternatives considered

- **仅以 skill 承载全部流程**：落败——skill 惰性加载可能整个会话不触发，约束力最弱；触发语必须常驻上下文（根 AGENTS.md），细节才外链文件。
- **细则全塞根 AGENTS.md**：落败——违背「每个事实只有一个家：规则 → 本文件 + 链接」的定位，命令配方会持续挤占字数预算。
- **search-routing 逐字照搬上游**：落败——上游断言「anysearch 是唯一后端、已接管内置 web_search」在本环境不成立（web profile 仍为 Exa provider），照搬即写入错误事实。
- **机械门禁管对话内行为**：不可行——门禁只能拦有产物经过检查点的行为；检索通道选择无产物可 lint，硬造仪式成本大于收益。

## Consequences

- 「讨论型会话零代码写入」从默契变明文；文档类决策记录仍是讨论型的本职产出。
- 强制天花板如实声明：行为类规则的约束 = 根 AGENTS.md 常驻注入 + 用户观察点名；若漂移反复，再评估升级为 MCP 工具形态（工具列表每轮可见）。
- 流程卡按需增删：新流程先立卡再执行，废弃的卡删除不留桩；workflows 不进字数预算 manifest（活文档靠评审不靠预算），相对链接由 verify-md-links 把关。

## Related

- [session-modes](../../../workflows/session-modes.md) / [session-open](../../../workflows/session-open.md) / [session-close](../../../workflows/session-close.md) / [feature-flow](../../../workflows/feature-flow.md) / [release-flow](../../../workflows/release-flow.md)：五张核心卡。
- [github-research](../../../workflows/github-research.md) / [search-routing](../../../workflows/search-routing.md)：两张纪律卡。
- 上游先例：dotnet-deepseek-harness-desktop `.agents/notes/implemented/process/2026-08-23-workflow-cards-and-rule-directory.md`（外部仓库）。
