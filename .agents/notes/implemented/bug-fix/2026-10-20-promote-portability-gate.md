# Agent Note: 提级加可移植性门禁，源工作区路径不得进全局

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

2026-10-20 首跑回填夜，`bash-workspace-only-staging` 带着本工作区路径（`/mnt/work/work`）被 `move-to-global` 进全局分区；工具层改不动实习期条目（`update`/`delete` 对全局区空转成功），最终只能直改中央库。根因是提级漏斗无可移植性检查：`promoteMemory` 只验 active/存在/不冲突，从不看正文里有没有源分区的绝对路径。全局行在所有工作区可读，一条带本机路径的记忆全局化即污染。

## Decision

`src/data/tiering.ts` 新增纯函数 `globalPortabilityReason(workspaceId, {title, description, body, notWhen})`：四字段任一含源分区路径即 fail-closed，判词点名首个命中字段（`xxx 含来源工作区路径，先改写为全局适用再提级`）。`promoteMemory` 在既有守卫之后、事务之前调用——它是工具手动与评审自动提级的唯一漏斗，一处设防全覆盖；`landPromote` 对 `!ok` 本来就是记账不抛错，新拒绝自动走该通道。空 workspaceId 永不命中（全局行不重筛）。`evolve_write` 的 move-to-global 描述加一句门禁预告。skills 提级未动（见 Consequences）。

## Alternatives considered

- **正文记忆约束（"创建全局记忆时注意"）**：检索靠钩子命中，是概率性的；创建时想的本就是工作区事，钩子恰恰最难命中。用户已明示偏好机械门禁。落败。
- **move 时自动改写路径为占位符**：机器改写用户正文语义不可控（占位符选什么、回指断不断），且静默改写违背"模型提议、代码保证"里代码只做判定的分工。落败，fail-closed 让写的人自己改。
- **在 surface 层（`evolve-memory.ts`）检查**：surface 只管字面透传，门禁语义归数据/服务层（现有 `secretLeakReason` 同样住数据层、服务层调用）；且 surface 检查覆盖不到评审自动提级。落败。
- **同时管 skills 提级**：skill 正文同样可能带路径，但本批无实例、无测试，越出既定方案属顺手改动；记 Consequences，待实例出现再议。落败（本次不做）。

## Consequences

以后带源路径的记忆提级会被门禁拒绝，判词指明字段；调用方（人或评审轨）按判词改写后重提。误伤面：正文合法讨论源路径的记忆（如记录迁移事项）也会被拦——属 fail-closed 方向，需人改写措辞绕行，这是故意的。skills 提级的可移植性未覆盖，待实例出现再议。代价：`promoteMemory` 新增一次四字段子串扫描，常量开销。

## Testing

`test/tiering-edges.test.ts` 新增三例：body 命中拒绝且源行保持 active；title 命名字段名、他分区路径放行；空 workspaceId 永过。`./node_modules/.bin/vitest run test/tiering-edges.test.ts` 41/41 绿；全量套件待提交前跑。

## Related

- [P6 注入演进](../architecture/2026-10-19-p6-injection-evolution.md)：D3 决策门数据源——全局记忆跨工作区可读性是注入分层的前提假设之一。
- [freshness 门列表 commit 兼容](./2026-10-20-eval-freshness-dash-commit.md)：同一夜的另一处生产/消费错位，修门禁而非绕门禁的同类。
