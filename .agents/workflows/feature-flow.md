# 功能开发流程（feature-flow）

> 非平凡功能/变更的主链路；琐碎修改走简化路径（实现+测试+提交）。
> 三重审核执行契约见本文件步骤 5，规范 ADR 为 [2026-10-19-review-triple-ts-gates](../notes/implemented/process/2026-10-19-review-triple-ts-gates.md)。

1. **定案**：方案讨论收敛 → 写 ADR（proposed）；Alternatives 强制。
2. **实现**：按 ADR 范围动 src/test/scripts/docs；越界想法记 TODO 不顺手做。改 `src/` 后 `tsc` build 才对运行中的 harness 生效，需用户重启验证时明确提醒。
3. **测试**：`pnpm test` 全绿 0 警告；行为级变更必须配套回归测试（vitest）。
4. **门禁**：文档门禁（`pnpm check:docs`，含 `verify-review-tier.ts` 档位判定）+ typecheck/lint 干净（pre-commit 跑 `--staged` 定档，pre-push 跑 `--since` 定档，CI 跑工作树兜底）。**评审档机械判定，无执行者自由裁量**：`./node_modules/.bin/tsx scripts/verify-review-tier.ts --staged`（提交前）或 `--since <base>`（推送前）——判 FULL 即须三重审核且证据随变更，判 LIGHT 才可轻审/简化；不得以「纯结构重构/纯文档」自判绕过 FULL。
5. **评审（三重审核执行契约）**：**第一步 = 机器定档**（步骤 4 已跑，此处以其输出为准）。**步骤 4 判 FULL 即强制重三审**（组装根/门禁判据/承诺三重审核的 proposed ADR/行为契约面命中任一即 FULL），通用轻审判据不得覆盖。**触发**——LIGHT 档内命中任一仍须重三审：触碰行为契约面（`src/`/`test/` 之外，含 workflows 打包/发版、`templates/`/`docs/` 契约口径、`client/` 渲染、`evals/`/`assets/` 提示词与基线）/ 涉及 async·生命周期·事件序·取消·异常·并发 / 改存储 schema 或 wire/配置格式 / 改发版链路 / 用户指定批量事后审核。**纯结构重构**（零行为变更，测试+门禁可证）走轻审或简化路径——由主会话用 `pnpm run change-scope` 输出 + 测试/门禁绿判定，改动进程 env 注入 / 公共 API 签名参数 / 子进程 spawn 形态 / 可观察副作用 / async·并发中任一命中即非零行为变更；模棱两可宁可重三审。契约：
   - **范围 = 单元 diff + 面收窄**：一次只审一个逻辑单元，评审代理拿精确 `git diff <base>..<head>`（用 `pnpm run change-scope` 界定）；**只读 diff 触及的文件 + 其直接依赖/被依赖的相邻件（一层以内）**，不开局读全仓标准面；标准面按 diff 面按需引用。
   - **评审对象冻结自证**：每轮评审代理启动前工作树必须冻结在暂存集上（`git status --porcelain` 只有暂存项）；违反先重暂存/清理再启动；简报 Scope 的 base/head 与冻结集一致；评审窗口内不再编辑在审文件。**每轮冻结后立即 `git write-tree` 记下本轮评审对象的 tree**——该 tree 即下一轮简报的 `base:`。
   - **父级预消化简报**：主会话先给每个代理一份紧凑清单（改了哪些文件、什么模式、风险点、1–5 条定向检查项 + 明确不做清单），而不是"加载技能 → 审一切"。**简报给"材料 + 检查项"，不给"结论倾向"**，审核代理须独立判读；未闭环点以"需父代理定向核"交回，不伪造行号证据。**启动任何评审代理前先跑 `./node_modules/.bin/tsx scripts/verify-review-brief.ts`**（FULL 需 R1/R2/R3 三路简报齐，LIGHT 需 R2；简报存 `.review-briefs/R<N>-<topic>.md`，gitignore，不进 CI）——简报未写齐即拦，杜绝无界任务。
   - **有界并行（上限两路）**：R1(dsh-find-simplifications) / R2(dsh-code-review) / R3(dsh-archive-agent-notes) 三路**最多两路并发，组合不固定**；**禁止三路同时并行**（R3 的 ADR 面结论可能因 R1/R2 代码面修复而失效）；**三路必须都在本轮内起跑，不得跨轮补跑**；FULL 证据行要求三路齐 `ok`。**评审任务须一次完整跑完，无「到限中断取部分结论」出口**——中断即未审计，中断后必须重新完整跑该路。
   - **确定性报告契约**：每代理返回 `Blocker[]`/`Suggestion[]`，每条 `文件:行 + 一句证据`；空即"无发现"。主会话逐条采纳/拒绝（附证据），修复一次性收口。**报告里的机制/因果断言在写入 ADR/注释前必须被证实**（未证实的标「推断」），同一主张只写一个家、其余留指针。
   - **收口契约（轮次有界，禁止反复审）**：**判据 = 本轮范围内 0 Blocker 即收口**——Suggestion 由主会话逐条书面裁定后收口，**不得为 Suggestion 再开一轮**；证据行 `R*=ok` 即「该路本轮 0 Blocker 且建议已书面裁定」。**每路每批 ≤3 轮**（首轮 + 最多两轮验轮），第 4 轮起仅用户显式授权（简报带行首非空「轮次授权：」行）才可开。**验轮只核处置、只审增量**：轮次 ≥2 的简报必须带 `## 上一轮结论的处置` 段，只重开上一轮报了 Blocker 的路，`base:` 必须是上一轮评审对象的 tree，评审 diff = `git diff <上一轮 tree> --cached`；验轮定向检查只写「处置是否闭合」，验轮报出的新问题转下批或挂账（仅「修复引入的新缺陷」计入 Blocker 并须修）。
   - **行为保持的第一证据 = 测试 + 门禁**：评审只补测试/门禁盖不住的语义/文档面，不重复全量重验。
   - 评审代理**须额外按**根 [AGENTS.md](../../AGENTS.md)「评审检查项（AI 兜底）」核对——上游 `dsh-*` 技能为通用清单、不含本项目规则，这些「留评审」项须显式补审。
6. **提交**：逻辑单元分粒度提交，conventional commits 格式。FULL 批随变更携带 implemented ADR 头区的 `Review: FULL/yyyy-mm-dd[#N]/R1=ok R2=ok R3=ok` 证据行（本批新产，单空格规范形）。
7. **推送 + 观察 CI**：main 推送触发 ci.yml，绿了才算完。
8. **收尾**：双语 README 数据同步（测试徽章与文件数、src 布局、配置表、功能清单）→ 更新工作区根 HANDOFF；ADR 随落地迁 implemented/。
