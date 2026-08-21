# Agent Note: 仓库卫生整理（测试临时目录自动清理 + 完结文档归档）

Status: implemented

## Problem

长期开发在工作树积累两类非追踪杂物：① 19 个测试套件在 `test/.tmp` 下 `mkdtempSync` 建状态目录且从不清理，残留 160+ 个临时目录随每次跑测试增长，污染工作树视图与磁盘；② 已完结的一次性审计报告（#14 重构审计 `docs/refactor-audit.md`）混在活跃设计文档里，"哪些是活文档"的边界模糊。杂物不进 git，但每次 `ls` 都在场。

## Decision

- `test/global-setup.ts` 挂为 vitest `globalSetup`：启动时确保 `test/.tmp` 存在（mkdtemp 的父目录前提），并返回 teardown——每轮测试结束递归清空该目录再重建空壳；崩溃残留也在下一轮启动收敛。测试套件自身的路径写法不变。
- `.gitignore` 增加 `.npm-pack-tmp/`（npm 发包暂存目录，内容可再生）。
- 新建 `docs/archive/` 承接已完结的一次性文档，`refactor-audit.md` 移入其中；活跃文档（design / FAQ / gap-analysis / experiment-bootstrap）原地不动。

## Alternatives considered

- **逐套件自清理**：抽公共 tmpdir 助手（mkdtemp + onTestFinished 自动删除）迁移全部调用点。落败原因：为卫生收益翻新 463 个全绿测试的基建，风险与收益不成比例；集中式 teardown 达到同样的零残留终态，未来新增套件也无需遵守额外约定。
- **测试改用系统临时目录**（os.tmpdir()）。落败原因：调试时状态不可见、跨平台路径差异需额外处理，且同样要动全部调用点。
- **refactor-audit.md 直接删除**。落败原因：它记录 #14 重构的取舍证据，属于决策审计链；归档保留检索性，成本只是一个子目录。

## Consequences

换来：任意次数跑测试后工作树无累积垃圾、`git status` 保持干净；完结文档与活跃文档边界清晰。付出：vitest 配置多一个 globalSetup 入口；旧路径引用方（会话交接记录）需指向 `docs/archive/` 新位置。
