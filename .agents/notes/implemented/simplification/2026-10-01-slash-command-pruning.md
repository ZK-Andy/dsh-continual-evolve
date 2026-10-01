# Agent Note: 斜杠命令剪枝 + 分层帮助

Status: implemented

## Problem

`/evolve` 有 25 个子命令、`command.ts` 780 行 / 34.2k 字符。用户提出"斜杠工具是不是没用了"，但此前**没有任何使用数据**——`plugin.log` 与 `reviews.jsonl` 都不记人类命令调用，只能凭感觉裁决。

本次用 DSH 会话日志（`~/.dsh/sessions/**/session*.jsonl.zstd`）里的 `command/run` 事件做了全量测量，覆盖 **1058 个日志文件 / 2026-08-13 → 2026-10-01**：

- `/evolve` 调用总数 **302**：08 月 283（几乎全是开发期自测/演示）、09 月 19、**10 月 0**。
- 有量的只有 `benchmark`(27) `plan`(9) `history`(4) `goal`(3) `rollback`(2) `list`(2) `usage`(1) `failures`(1) `mount`(1) `wrapup`(1) `status`(1) `pause`/`resume`(各 1)。
- **12 个子命令从未被调用过一次**：`remember` `forget` `recall` `consolidate` `archive` `unarchive` `demote` `export` `import` `log` `unmount` `help`。

关键区分：**零调用 ≠ 可删**。`export`/`import`/`pause`/`resume`/`status`/`log`/`archive`/`unarchive`/`unmount` 是"出事才用"的应急阀门，平时零调用是正常态。

## Decision

**剪枝四条**（判据是"v2 是否已把这条路径搬进对话"或"是否是别名"，不是单看调用数）：

- `remember` / `forget` / `recall` —— evolve v2 的注入指南正文本身就把这三件事交给了对话（"用户明确要求记住时，立即存为最合适的类型"/"要求忘记时，找到并删除相关条目"/"需要检索完整内容…调用 evolve_recall"），且模型工具 `evolve_add`/`evolve_delete`/`evolve_recall` 齐备；三条命令成为 v2 设计的重复面（实测 6 天窗口 0 调用）。
- `demote` —— 只是 `archive <id> global` 的别名（原实现按 global→project→local 顺序找 id），能力无损失。

**保留 `consolidate`**（唯一一条零调用但明确不删的）：它是 global 库批量的唯一清理路径（`merge` 折叠近重复内容），有两条专属 ADR（08-24 / 08-28），且针对 OBSERVATION 已记录的真实问题（global 漂移、近重复沉淀）。零调用更可能是"没遇到维护时刻"而非"不需要"。列为下一个候选。

**帮助分层**：`/evolve`、`/evolve help` 只列 11 条常用（查看/回滚/规划/收尾/归档/流水线开关），`/evolve help all` 展开进阶半区（consolidate/failures/log/export/import/mount/goal/benchmark/usage）。减少认知负担靠分层，不靠删能力。

## Alternatives considered

- **按零调用一刀切删 12 条**：会把应急阀门（export/import/pause/status/log/unmount/archive/unarchive）一起砍掉——这些平时零调用正是设计预期，出事时没有替代路径，拒绝。
- **连 `consolidate` 一起删**：实测 0 调用，但它是 global 库唯一的批量清理路径且有两条 ADR 与已记录的真实需求，删掉等于把"已知问题的唯一解"移除，拒绝（改列候选）。
- **只从帮助里隐藏、代码保留**：用户看不到就会以为已删，代码与文档互相说谎，且死代码继续吃维护成本（本次已顺手清掉 `demoteEntry` 与 3 个 import），拒绝。
- **先加命令遥测再等数据**：会话日志里 `command/run` 已含全量历史（1058 文件），加遥测是重复建设；真正缺的是**测量纪律**不是数据源，拒绝。
- **删 `list`**（模型有 `evolve_list` 工具）：它被真实调用过 2 次，且是人类浏览 store 的入口，拒绝。
- **保留 `remember` 作为"确定性写入"通道**（不依赖模型判断）：方向合理，但与 v2 指南的点名授权直接冲突（两套写路径要说两遍），且 6 天 0 调用，拒绝。

## Consequences

- 子命令 25 → 21；`command.ts` 34240 → 27100 字符（−21%）；测试 1108 → 1097（删 13 条被删命令的测试，新增 2 条：分层帮助 + 被删命令不再接受）。
- 写/读记忆的路径收敛为一条：对话。用户在对话里说"记住/忘掉/查一下"，由模型经 `evolve_add`/`evolve_delete`/`evolve_recall` 落地——与 v2 的 when_to_save 指南同源。
- `recall.ts` 模块保留（`evolve_recall` 工具在用）；`consolidate.ts` 保留。
- **测量方法论与两个陷阱**（供后续复测，已记入 OBSERVATION.md）：①会话日志被 fork 复制进多个文件，原始计数虚高 9 倍，必须按 `distinct args` 去重；②会话日志有 `session.jsonl.zstd` 与 `session.v2/v3/v4.jsonl.zstd` 多代格式，只扫老格式会把覆盖期误判到 09-08（实际到 10-01）。
- 复测建议：积累 2–4 周新数据后重跑同一测量，再裁决 `consolidate` 与 `usage`/`log` 等低频项。
