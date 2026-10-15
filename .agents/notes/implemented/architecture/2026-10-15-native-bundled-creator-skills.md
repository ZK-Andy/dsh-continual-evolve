# Agent Note: 自带 creator 技能走原生 bundled provider

Status: implemented

> P6（`docs/plans/2026-10-15-layered-generic-repository.md` §86）把 `evolve-skill-creator` / `evolve-memory-creator` 放进 repo `.agents/skills/`；2026-10-15 当晚复盘发现该归属只服务本仓开发者，npm 用户装完插件拿不到（包 `files` 无 `.agents/`），改走上游打包技能机制。

## Problem

自带 creator 技能（`evolve-skill-creator` 写技能、`evolve-memory-creator` 写记忆）的消费者是调 `evolve_write` 的模型，绝大多数会话发生在用户自己的仓库。P6 把它们放进 repo `.agents/skills/`：该路径依赖宿主按 cwd 发现（projectRoot 取最近 `.git`，否则 cwd），工作区根启动的会话静默缺失；npm 包 `files` 不含 `.agents/`，用户侧完全不可见。

## Decision

照上游 `dsh-skill-badge` 同构实现（`src/surfaces/skill-provider.ts`）：两份正文进包内 `assets/`（`package.json` `files` 加 `assets/*.md`），组装根经嵌套 inject 拿 `skills` 服务后注册 immutable provider——`list()` 不碰文件系统，`get()` 每次现读资产（无 body 缓存），candidate 挂 bundled rank 600。repo `.agents/skills/` 下两份删除，`assets/` 为单一事实源；`.agents/AGENTS.md` 技能节同步。服务缺失时 warn 降级，不挡 section 与工具。

## Alternatives considered

- **维持 repo 现状**：本仓可用、npm 用户不可见。落败（服务对象错位）。
- **DB 种子行**：种子一进库脱离版本控制，改了算库的还是算包的；且新克隆/新机无行。落败。
- **挂载复制进 `~/.dsh/skills`**：绕过 provider 注册，无生命周期——插件卸载后文件变孤儿；且与巡检标记共用目录。落败。
- **规则塞进 tool description**：description 预算只放得下干货，且与 skill 渐进加载重复（常驻 token）。落败，只保留门禁硬约束。
- **P6 的"全局无归属、与搬家物化混淆"**：provider 自带名字空间与 bundled 来源位，归属即随包版本；搬家物化只认生成标记，互不相交。原拒绝理由不成立，本文推翻重判。

## Consequences

- 插件挂载的 profile 下所有工作区会话 catalog 可见（项目/全局分流是用户内容的，不受影响）；插件禁用/卸载即消失。
- 代价：组装根多一次嵌套 inject（缺失降级）；`check:pack` 多两个资产文件；测试 +6（472 全绿）。
