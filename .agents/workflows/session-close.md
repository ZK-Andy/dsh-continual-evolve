# 会话收尾检查单（session-close）

> 会话结束/阶段性告一段落时执行；全部完成才算收尾（教训：未记录的提交曾导致下个会话误读决策；HANDOFF 无界膨胀到 103KB 后才拆分治理）。

1. **提交对账**：`git log` 本会话全部提交 vs HANDOFF 滚动窗——每条提交必须能对应到交接条目。
2. **决策落档（结论只落 durable 家）**：本轮拍板结论是否已进 ADR（`.agents/notes/`）/ docs / README？没有则补。**滚动窗只留指针不复述结论**；凡待跨会话用的复现细节/判据，正文进 durable 家。
3. **待办对账（跨会话遗留的唯一落点）**：工作区根 `HANDOFF-todos.md` 增删（`[ ]` 条写清事项 + 触发条件 + 指针，≤340 字）；不在滚动窗留副本。`[x]` 压缩为一行指针，越过窗口（24 条）整批移入 `HANDOFF.archive.md`。
4. **未推送提醒**：本地领先 origin 的提交数如实告知用户；是否推送由用户定或按既定惯例（本项目惯例：完成即推）。
5. **工作树确认**：`git status` 干净；仓库内不应有未跟踪文件（HANDOFF 家庭与 OBSERVATION 在工作区根，仓库外）。
6. **交接条目**：HANDOFF.md 滚动窗顶部追加一条——`日期｜类型｜commit/ADR 指针｜一句话结论`（≤260 字）；越过窗口上限（12 条）整批移入冷归档。
7. **结构门禁**：`python3 scripts/verify-handoff-structure.py` 全绿（越窗/超长/断指针即 FAIL 并指名归档路径）；已并入 pre-push 与 `pnpm check:docs`。
