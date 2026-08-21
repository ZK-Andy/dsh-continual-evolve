## 变更范围

<!-- 改了什么，为什么 -->
-

## 最小证据

<!-- 按 diff 面选最窄检查，贴 change-scope 或 CI 链接 -->
- `scripts/change-scope.sh` 输出：
- `CI` 链接：

## Reviewer Checklist

- [ ] 非平凡变更已附 `ADR`（`.agents/notes/implemented/<class>/yyyy-mm-dd-*.md`）且含 `## Alternatives considered`
- [ ] 公共 API 有 TSDoc 契约（`@param/@returns/@throws`）
- [ ] 行为级变更有回归测试（vitest）
- [ ] `try` 只包一个语句，空 `catch` 已命名吞掉什么
- [ ] 文档写当前状态，无 `previously/now/no longer/renamed` 叙事
- [ ] 相对 `Markdown` 链接可校验（`verify-md-links` 通过）
- [ ] 未用裸 `string` 跨界 ID（用 Branded 类型）
- [ ] 改写历史用 `--force-with-lease=<branch>:<oid>`（禁 `raw --force`）
- [ ] `ADRs` 路径即元数据：`rejected` 仅当能防重蹈覆辙才保留

## 关联 Issue

Closes #
