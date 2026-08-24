# 会话开场检查单（session-open）

> 每次会话恢复/开始时顺序执行；全部完成后向用户复述关键状态并等待命令。

1. **读 HANDOFF 全文**——工作区根 `/mnt/work/work/HANDOFF.md`；重点：顶部交接更新记录、当前待办、Gotchas。
2. **git 对账**：`git log --oneline -8 && git status`
   - HEAD 若比 HANDOFF 最新记录**多出提交**：逐条查明内容再继续（教训：未记录的提交曾导致决策误读）。
3. **门禁基线**：verify-adr-format / verify-doc-budgets / verify-md-links 三脚本全绿。
4. **TS 基线**：`pnpm typecheck && pnpm lint && pnpm test` 全绿（当前 33 文件 / 527 测试）。
   - 沙箱下 pnpm 报 deps-status/sqlite 错时直接用 `./node_modules/.bin/{tsc,oxlint,vitest}` 绕过（2026-08-24 实证）。
5. **声明会话模式**：按 [session-modes.md](session-modes.md) 与用户确认本轮类型与边界。
6. 向用户复述：关键状态、当前待办、相关 Gotchas；然后等待命令。
