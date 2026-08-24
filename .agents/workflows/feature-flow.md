# 功能开发流程（feature-flow）

> 非平凡功能/变更的主链路；琐碎修改走简化路径（实现+测试+提交）。

1. **定案**：方案讨论收敛 → 写 ADR（proposed）；Alternatives 强制。
2. **实现**：按 ADR 范围动 src/test/scripts/docs；越界想法记 TODO 不顺手做。改 `src/` 后 `tsc` build 才对运行中的 harness 生效，需用户重启验证时明确提醒。
3. **测试**：`pnpm test` 全绿 0 警告；行为级变更必须配套回归测试（vitest）。
4. **门禁**：三文档脚本全绿 + typecheck/lint 干净（pre-push 会再拦一次）。
5. **评审**（重大变更）：dsh-find-simplifications → dsh-code-review → dsh-archive-agent-notes，逐轮收口。
6. **提交**：逻辑单元分粒度提交，conventional commits 格式。
7. **推送 + 观察 CI**：main 推送触发 ci.yml，绿了才算完。
8. **收尾**：双语 README 数据同步（测试徽章与文件数、src 布局、配置表、功能清单）→ 更新工作区根 HANDOFF；ADR 随落地迁 implemented/。
