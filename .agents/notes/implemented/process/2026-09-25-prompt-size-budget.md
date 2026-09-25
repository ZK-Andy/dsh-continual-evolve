# Agent Note: 提取 Prompt 尺寸预算

Status: implemented

## Problem

提取 system prompt 随质量修补逐轮变长（排除清单、具体性规则、示例，现状 2646 字符 / 21 行），而它是每提取 turn 都发送的常驻成本（最多 5 turn/快照）。无约束时下一次"加两行示例"毫无阻力，Prompt 会无秩序膨胀成小模板。

## Decision

- `MEMORY_AGENT_SYSTEM_PROMPT_BUDGET_CHARS = 3000`（现状 + 约 13% 余量）：小修不挡路，整段粘贴（如 ZCode 全模板 ~8k 字符）会被拦。
- 测试断言长度 ≤ 预算：超预算的提交必须在同一提交里上调 cap——cap 上调本身就是一次显性评审（diff 里可见），回归压力代替静默膨胀。
- 只管本 Prompt：通用 planner/wrapup 的提示词不在本次范围，真膨胀了另起预算。

## Alternatives considered

- **行数预算**：行可长可短，字符数更接近 token 成本；拒绝。
- **doc-budgets.manifest 式脚本门禁**：那是给 Markdown 文档的；Prompt 是代码常量，单测断言更近、CI 同跑，拒绝另起脚本。
- **预算卡死现状零余量**：每个标点修改都要动 cap，摩擦过大导致绕行（拆文件、注释豁免）；13% 余量够一次小修，拒绝零余量。
- **token 精确预算**：需 tokenizer 依赖（与零原生依赖原则冲突）；字符数是足够好的代理，拒绝。

## Consequences

- 下次加示例先看余量：超了就提 cap 并在提交说明理由。
