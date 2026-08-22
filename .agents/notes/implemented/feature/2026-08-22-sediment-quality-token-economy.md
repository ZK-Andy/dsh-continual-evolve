# Agent Note: 沉淀质量与 token 经济治理（晋升守卫/注入节流/计量修正）

Status: implemented

## Problem

2026-08-22 对运行中 store 的审计（26 全局条目 / 19 本地会话 / 184 条门禁记录）发现三类系统性问题：① 全局库被当作垃圾抽屉——C#/.NET 条目、项目运营手册、42–96ch 的一句话事实全部晋升全局，而一个 profile 共享一个全局库，每个项目的每次构建都为其付税；② 同主题被跨会话重复晋升（"初始化顺序"4 次批准），标题匹配的去重挡不住换措辞的复述；③ 计量口径失真——usage 只记 prompt/subagent 且按每次构建累加（单条 2311×），B2 自动衰减没有可用信号。另有晋升管道把 merge 视图的 `local:` 前缀 id 写进全局库、物化 SKILL.md 的 description 只有标题无路由信息两个缺陷。

## Decision

- **晋升守卫**（`src/promotion.ts`，接入 `filterPromotable` / `splitPromoteBlocked` 单一咽喉）：内容命中 blockPatterns（默认：POSIX 绝对路径 / session-id / `~/.dsh`）→ 项目级，留本地；正文低于 `promotionMinChars`（默认 100）→ 太薄不晋升；与同 kind 全局条目做归一化 token Jaccard 相似度（ASCII 词 + 中文 bigram），超 `maxContentOverlap`（默认 0.6）→ 判近似重复并指名"应 update 该条目"。三者均可经 schemastery 配置覆盖。
- **注入节流**：条目目录 cap `injectionDirectoryLines`（默认 15 行），超出折叠为计数行；冗余跳过检查只对有内容段的 kind（prompt/subagent）生效——修复了 memory/skill 条目 ≤6 时完全不可见的连带 bug。
- **计量 v2**：usage.json 升级 `{version:2, counts, lastSession}`（兼容读旧扁平格式）；四种 kind 全部计数；按会话去重——计数语义变为"多少个会话见过它"，衰减有了真信号。
- **demote 命令**：`/evolve demote <id>` 把全局（或本地）条目就地归档，数据保留可 unarchive——全局污染的一命令解药。
- **id 卫生**：apply 对 CREATE 动作剥离 `local:`/`global:` 前缀；update/delete 不动（需寻址既有条目）。
- **skill 路由提示**：物化 description = 标题 + 首个有意义正文行（"use when: …"模板），空标题回退纯提示。

## Alternatives considered

- **引入第三作用域 "project"**（global/local/project 三层）。落败原因：需要迁移 wire 格式、改所有寻址路径，且当前痛点（跨项目噪声）用守卫 + 目录 cap + demote 已解决；等真实需求出现再立项。
- **晋升判定交给 LLM 判断是否通用**。落败原因：违反"模型提议，代码保证"；正则 + 重叠度是机械可复现的，LLM 判定继续留在分类阶段。
- **memory 内容直接注入 system-prompt** 以提高晋升收益。落败原因：与节流方向相反——先让错误沉淀进不了全局、再谈提升可见性。

## Consequences

换来：全局库只收"可携带、有分量、非重复"的沉淀；每次构建的目录开销有上界；使用计数首次真实可信。付出：晋升通过率会显著下降（这是目的）；旧扁平 usage.json 首次写入后升级为 v2 形状（单向，读取端永久兼容旧格式）；依赖"短条目必被晋升"的旧工作流会被守卫拦下并给出理由。

## Testing

`test/promotion.test.ts`（守卫全分支）、inject（cap 折叠 + 全 kind 会话去重计数）、usage（v2 往返 + 旧格式兼容）、apply（前缀消毒 + update 不动）、command（demote 三路径）、skill-render（路由提示 + 空标题回退）。527 例全绿。
