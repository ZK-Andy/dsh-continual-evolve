# 发版流程（release-flow）

> npm 发版全链路；历史踩坑沉淀于此（0.1.0~0.4.0）。

1. **版本基线**：只改 `package.json` 的 `version`——pnpm v9 lockfile 无 root version 字段，勿找 lockfile。
2. **预检**：`pnpm typecheck && pnpm lint && pnpm test` 全绿；双语 README 数据同步已完成（测试徽章与文件数、配置表、功能清单）。
3. **提交 + tag**：`chore(release): vX.Y.Z` 提交 → 写 notes 并提交（下一步 4 的 `docs(release)`）→ **annotated tag `vX.Y.Z` 打在 notes 提交上**，再推送 origin。tag 落点以 v0.7.3–v0.7.6 为准：notes 文件必须随 tag 一起可审计；先打 tag 再补 notes 会让 tag 指向 bump 提交，需删远端 tag 重推（无 Release 时方可）。
4. **GitHub Release**（DSH 版式，见 `implemented/process/2026-09-24-github-release-notes`）：
   ```sh
   scripts/draft-release-notes.sh <prev-tag> <new-version>   # 输出 releases/vX.Y.Z.md 草稿（prev-tag..HEAD 按 feat/fix 分组）
   # polish：英文区润色、作者名换 @handle，确认 compare 链接两端 tag 正确
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file releases/vX.Y.Z.md
   ```
   - **必须显式传 `<prev-tag>`**：脚本默认取"最新 reachable tag"，而在 tag 已打的情况下那正是本版自己，range 变空产出全 `（无）` 草稿。
   - notes 文件进仓（`releases/`，随 tag 审计）；`chore(release)` 提交本身不进条目（脚本已过滤）。
   - 无 prev-tag 的首版取全历史，属一次性行为。
5. **发布**：

   ```sh
   npm publish --userconfig=/mnt/work/work/.npmrc --cache=/mnt/work/work/.npm-cache
   ```

   - token 存工作区 `.npmrc`（0600，openorbit 账号，用户确认长期复用，无需 revoke/转 Automation）
   - `prepare` 脚本自动 tsc build；沙箱 `/home` 只读视图下裸 `npm publish` 报 EROFS（写 `~/.npm/_cacache` 失败），上述两个参数是绕过正解
6. **核验**：`npm view dsh-continual-evolve version` 与 `dist-tags.latest` 命中新版本；GitHub tag 已在远端；GitHub Release 已发布（notes 双语、作者、compare 链接齐全）；README 徽章数据与本版一致。
   - **`npm view` 同样要带 `--cache=/mnt/work/work/.npm-cache`**（读也会写 `~/.npm/_cacache`，裸跑报 EROFS）；核验命令因此为
     `npm view dsh-continual-evolve dist-tags --json --cache=/mnt/work/work/.npm-cache --userconfig=/mnt/work/work/.npmrc`。
   - npm 会先回 `+ <pkg>@X.Y.Z` 再提示"being processed"，**dist-tags 传播有延迟**：`version` 与 `latest` 要轮询到命中为止（实测约 1 分钟），不要以 publish 退出码或首次 `npm view` 为准。
7. **收尾**：HANDOFF 记录版本号、提交哈希与发布日期；遗留项进待办。

## 已知坑位速查

- openorbit 2FA 为 passkey-only 形态常年启用，npm CLI 无法 OTP 交互——必须 token 发布，勿尝试交互登录。
- devDependencies 不进发布产物、peerDependencies 未变时零行为变化——**不构成发版理由**（2026-08-21 实证，npm 保持原版本）。
- peerDependencies 保持 `^0.1.0-rc.6` 起步的宽范围即可覆盖新 rc；升 devDeps 对齐上游 rc 时同步核对 CI frozen-lockfile（pnpm-workspace.yaml 的 minimumReleaseAgeExclude 残留会炸 frozen 安装）。
- 发版后回读验证（version/latest/tag 三点），不只看 publish 退出码。
