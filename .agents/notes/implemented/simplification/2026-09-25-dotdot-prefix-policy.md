# Agent Note: `../` 前缀口径拍板（前导互链放行、内嵌转义拦截）

Status: implemented

> 放置路径：`.agents/notes/implemented/simplification/2026-09-25-dotdot-prefix-policy.md`

## Problem

`../` 口径不一致：`validateSkillEntryContent` 的正则只匹配 `references/`/`scripts/` 开头，只拦内嵌 `/../`（如 `` `references/../evil.mjs` ``）；前导 `../`（如 `` `../skill-creator/…` ``）根本匹配不上，直接放行。而 `skillResourceRefs` 明确把前导 `../` 当跨 skill 互链跳过（测试钉死）。但前者 TSDoc 却写着"parent-relative（`../`）……are rejected"——注释撒谎，行为和另一边实际一致。

## Decision

- 口径：前导 `../` = 合法跨 skill 互链（放行、不做悬空检查，目标住在兄弟 skill 目录，不在 shipped 文件里，查了必误报）；类别后的内嵌 `/../` = 转义（拦截）。
- 改动：零行为变更。只改两处注释（`validateSkillEntryContent` TSDoc 缩窄为内嵌口径并指到互链规则；`skillResourceRefs` TSDoc 补跳过原因）+ 1 例前导 `../` 放行测试（此前该路径无测试覆盖）。
- 备选（拒掉）：把前导 `../` 也拦掉——自家 skill 就用兄弟互链（`skill-creator` 模板引用），拦了自断经脉。落败。

## Alternatives considered

- **resource-refs 对 `../` 做跨仓悬空检查**：`skillResourceRefs(content)` 无 skill-root 参数，解析目标需要新入参并穿透调用链；且兄弟 skill 未必已安装，误报率高。落败（保持跳过）。
- **保持注释不动**：注释与行为/测试三方矛盾，下一个读者必踩坑。落败。

## Consequences

- 收益：注释、行为、测试三方一致；`../` 口径待办关闭。
- 代价：无（注释 + 1 测试）。
- 后续：函数 99.51 与分支 83 线按用户拍板封存不动。

## Testing

- `pnpm test` 1032 全绿（54 文件）；tsc/oxlint/TS 四门禁全绿。
