# 发版流程（release-flow）

> npm 发版全链路；历史踩坑沉淀于此（0.1.0~0.4.0）。

1. **版本基线**：只改 `package.json` 的 `version`——pnpm v9 lockfile 无 root version 字段，勿找 lockfile。
2. **预检**：`pnpm typecheck && pnpm lint && pnpm test` 全绿；双语 README 数据同步已完成（测试徽章与文件数、配置表、功能清单）。
3. **提交 + tag**：`chore(release): vX.Y.Z` 提交；annotated tag `vX.Y.Z` 推送 origin。
4. **发布**：

   ```sh
   npm publish --userconfig=/mnt/work/work/.npmrc --cache=/mnt/work/work/.npm-cache
   ```

   - token 存工作区 `.npmrc`（0600，openorbit 账号，用户确认长期复用，无需 revoke/转 Automation）
   - `prepare` 脚本自动 tsc build；沙箱 `/home` 只读视图下裸 `npm publish` 报 EROFS（写 `~/.npm/_cacache` 失败），上述两个参数是绕过正解
5. **核验**：`npm view dsh-continual-evolve version` 与 `dist-tags.latest` 命中新版本；GitHub tag 已在远端；README 徽章数据与本版一致。
6. **收尾**：HANDOFF 记录版本号、提交哈希与发布日期；遗留项进待办。

## 已知坑位速查

- openorbit 2FA 为 passkey-only 形态常年启用，npm CLI 无法 OTP 交互——必须 token 发布，勿尝试交互登录。
- devDependencies 不进发布产物、peerDependencies 未变时零行为变化——**不构成发版理由**（2026-08-21 实证，npm 保持原版本）。
- peerDependencies 保持 `^0.1.0-rc.6` 起步的宽范围即可覆盖新 rc；升 devDeps 对齐上游 rc 时同步核对 CI frozen-lockfile（pnpm-workspace.yaml 的 minimumReleaseAgeExclude 残留会炸 frozen 安装）。
- 发版后回读验证（version/latest/tag 三点），不只看 publish 退出码。
