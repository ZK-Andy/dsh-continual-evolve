# Agent Note: 技能接线 S1——项目技能库、手动写、文件投影

Status: implemented

> 放置路径：`.agents/notes/implemented/feature/2026-10-11-skill-wiring-s1.md`
> 对应讨论结论（2026-10-11 会话）：创建只能是项目、全局只接受手动搬家；库是唯一真相、文件是生成投影。

## Problem

提取轨稳定后，自进化下阶段第一步是技能接线，但 10-04 终极收敛已把技能整套删除（`src/skill.ts`、`skill-render.ts`、`skillquality.ts`、`mount.ts`，见 `dc1e679`）。可复用的操作规程无处沉淀，`skill` 工具发现不了库里的内容。且有两个预先定死的语义，否则就是新坑：①库与物化文件两份拷贝谁是真相；②全局与项目重复时谁遮蔽谁、token 花几份。

## Decision

S1 是最小手动闭环，无自动、无晋升机制：

- **存储**：同库（`memory.db`）新表 `skills`（`workspace_id` 分区，字段对齐 `memories`：kebab id、title、description、body 64KB、status、来源、时间）+ `skills_fts`（trigram）+ `skill_log`（before/after 全文 + 文件投影告警）。**创建只能是项目**，全局行只由手动搬家产生。
- **写入口**：`skill_write`（create/update/delete/手动搬家）+ `skill_read`（按 id 取正文、按关键词检索），镜像 `memory_write`/`memory_read` 的裸注册形状与门禁（kebab 规范、CJK hash 兜底、secret 正则、64KB 上限）。提取轨不产技能提案。
- **物化（库是真相，文件是只读投影）**：插件代码是唯一写者，落库成功后把 active 行渲染为 `SKILL.md`（frontmatter `name/description`，description 携带路由 hint ≤240，老 `skill-render.ts` 规则原样捡回；官方 skill-creator 模板本地已缺失，以宿主现行 preset 技能格式 + 老校验规则为准）。项目技能写回本工作区 `.agents/skills/<kebab>/SKILL.md`，文件头打生成标记；模型禁直写文件，巡检发现缺失/漂移按库重写、无主托管文件删除、手改文件保留并告警。
- **手动搬家**：用户明确说到处用才执行一次：全局建行 + 物化到 `~/.dsh/skills/<kebab>/`，同时项目行归档 + 项目文件删除——永远只有一份 active，没有计数器、置信度与自动触发。
- **遮蔽与去重**：同 kebab 项目遮蔽全局（读、检索、列表、卡片一致，只花一份 description token，body 按需加载）；创建时同名全局已存在即拒绝（内容相同提示直接调用），正文完全相同即拒绝（指向已有的那条）。
- **读面**：卡片加只读技能列表 + 按 id 预览（项目技能 + 可见全局技能，全局行打标记）；6k 记忆注入预算不动。`mostRecentlyActiveWorkspace` 计入技能写入，技能-only 分区照常成为卡片默认。
- **加载**：V1 重启生效，热挂载（老 `mount.ts`）按需再做。

## Alternatives considered

- **复用 `memories` 表加 `type='skill'`**：CHECK 枚举、注入排序、卡片查询全要分支，且技能字段语义（kebab/frontmatter）与记忆不同。落败。
- **文件即真相（模型直写 `.evolve/skills/`）**：回到 10-04 被否的老路——漂移、frontmatter 腐坏、secret 全靠自觉。落败。
- **一步到位热挂载 + 提取自动产技能**：单人信号稀（215 skip 换 13 applied），自动产大概率是噪声；热挂载多一套生成插件审计面。落败，先手动后自动。
- **全局可直接创建**：A 项目的套路污染 B 项目的触发，且全局文件名冲突无归属。落败，创建只能项目。

## Consequences

- 技能沉淀不断 `skill` 工具的发现链：写一次 projection，重启即用；隔离性沿记忆分区走，默认零交叉污染。
- 代价：文件投影是第二份字节（只读缓存，巡检对账）；卡片多两个只读端点；V1 每次技能变更要重启宿主才生效。
- 验证：258 测试（含 59 个新增技能回归）/ typecheck / lint / 文档门禁 / `check:pack` 全绿；覆盖率 statements 96 / branches 90 / functions 100。
