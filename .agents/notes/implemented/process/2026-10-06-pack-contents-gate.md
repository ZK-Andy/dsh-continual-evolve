# Agent Note: 发布产物一致性门禁（干净构建 + check:pack）

Status: implemented

## Problem

npm 上 `dsh-continual-evolve@0.15.0` 的 tarball（38 文件）里带着四个**已退役模块**的构建产物：`lib/known-workspaces.{js,d.ts}`、`lib/workspace-catalog.{js,d.ts}`。这两个模块在 v0.15.0 的卡片查库改造中已从 `src/` 删除（`index.js` 不再引用它们，运行无影响），但它们的旧 `.js`/`.d.ts` 仍被打包发布，包体多出约 9KB，且让"这个包有哪些模块"的读者得到错误答案。

根因是五个条件同时成立：

1. `lib/` 是 gitignore 的**持久**输出目录，不是每次从零生成；
2. `build`/`prepare` 只跑 `tsc`，而 **tsc 从不删文件**——源文件被删后，对应产物原地留存，编译不报错；
3. `files` 白名单是通配 `lib/**/*.js` + `lib/**/*.d.ts`，把整个 `lib/` 装包；
4. 现有门禁（`check:docs` / typecheck / lint / test / coverage）与 CI 的 Build 步骤**没有一步观察"产物集合"**；
5. 没有 `prepack`/`prepublishOnly`，发布路径上没有"包内容"检查点。

结果是：**今后任何"删除或重命名 `src/` 模块"的改动，其旧产物都会随下一次发布溜出去**。这次是 4 个文件，下次可能是整块退役模块。

## Decision

- **根因消除**：`build` 改为 `npm run clean && tsc -p tsconfig.json`；`clean` 用 `node -e "fs.rmSync('lib',{recursive:true,force:true})"`（跨平台、零依赖）。`prepare` 复用 `npm run build`，本地 install 与 CI 都得到干净产物。
- **回归门禁**：新增 [../../../../scripts/verify-pack-contents.ts](../../../../scripts/verify-pack-contents.ts)（`pnpm check:pack`），校验三件事并**指名失败文件**：
  1. `lib/**` 的每个 `.js`/`.d.ts` 都能在 `src/` 找到同名模块（残留）；
  2. `src/` 的每个 `.ts` 都有配对的 `.js` 与 `.d.ts`（缺失）；
  3. `package.json` 的 `files` 白名单每项至少命中一个真实文件（白名单空匹配 = 静默漏发）。
  `lib/` 不存在时输出 SKIP 并以 0 退出（干净检出的语义，与 `verify-handoff-structure` 一致）。
- **接入发布与 CI 两条路径**：`prepack` = `npm run build && npm run check:pack`（`npm pack` 与 `npm publish` 都会触发）；`.github/workflows/ci.yml` 在 Build 之后加一步 `pnpm check:pack`。门禁是 TS 脚本、零外部依赖，进 `tsconfig.scripts.json` 的类型检查范围。

## Alternatives considered

- **只做干净构建，不加门禁**：一行改动就能让本次残留消失。落败原因：它依赖"以后没人往 `lib/` 里放别的东西、没人换构建器"，而这类问题的特征正是**没有人会想起来检查**；机械门禁必须独立存在才能防复发。
- **只加门禁，不做干净构建**：门禁会在发布前失败并让人手工删文件。落败原因：把"每次发布前手动清理"变成流程债，且 `npm pack` 之外的路径（例如直接 `files` 取包）仍会带上残留。
- **用 `npm pack --dry-run --json` 的真实清单做校验**：最权威，还能发现"白名单通配把非预期文件带出去"。落败原因：引入对 npm CLI 与可写缓存的运行时依赖（本仓沙箱下 npm 缓存会 EROFS 报错），而它多覆盖的那类风险等价于"`lib/` 里有孤儿文件"——已由第 1 项检查覆盖。
- **引入 `rimraf` 等依赖**：跨平台删除更"标准"。落败原因：`node -e` 一行即可，本项目坚持零运行时/工具依赖膨胀。
- **把门禁挂到 `.githooks/pre-push`**：本地就能拦住。落败原因：pre-push 定位是快检，而这门禁依赖构建产物（需要先 build），且它防的是**发布**动作，`prepack` + CI 才是正确位置。
- **发布后核验包内容**：不改任何构建配置。落败原因：npm 已发布版本不可撤回，事后发现只能发新版纠正，代价远高于事前失败。

## Consequences

- `lib/` 从"持久累积目录"变成"每次构建的完整投影"，删除/改名 `src/` 模块不再留下幽灵产物。
- 发布路径（`prepack`）与 CI 各有一道不可绕过的检查；本地 `pnpm check:pack` 未构建时 SKIP，不产生误报。
- 当前 `lib/` 为 13 模块，门禁输出 `OK（13 模块 / 7 白名单项）`；两次自证（注入一个假 `lib/ghost-module.js`、移走 `lib/store.js`）分别以残留与缺失报错退出 1。
- 已发布的 0.15.0 无法撤回，其包内四个残留文件**随下一版消失**——本变更未发版，只进 main。
