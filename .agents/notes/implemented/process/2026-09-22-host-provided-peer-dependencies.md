# Agent Note: 宿主提供的运行期依赖统一声明为 peerDependencies

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

插件以 `dsh.bundle` 形态挂到 profile 下，运行期从宿主进程借包，但"哪些包算宿主提供、以哪个版本为准"此前没有可审计的判据：`@deepseek-ai/schemastery` 是 `lib/index.js` 的运行期值导入，却只存在于 devDependencies；已声明的 peer 范围 `^0.1.0-rc.6` 在 node-semver 下连实际运行过的 0.1.1-rc.2 与 0.1.7-alpha.1 都不满足（预发布版只被同 `major.minor.patch` 的比较符接受）；devDependencies 又停在 2026-08 的 0.1.1-rc.2。

三个后果。其一，profile 里可能出现两份 schemastery，配置 schema 的类型与实例身份不一致。其二，dsh 0.1.7-alpha.1 起 profile 解析改为运行时拦截：位于 linked root（`link:` 到仓库目录的插件）的模块，只有被该目录的 `peerDependencies` 列名才路由到宿主副本，未列名者退化为沿插件目录向上原生查找，消费方只装发行包时以 `ERR_MODULE_NOT_FOUND` 告终。其三，peer 声明的版本与 devDependencies 的类型面各说各话时，编译期看到的 API 不是运行期用的 API，漂移只能等真实会话暴露。

## Decision

判据是**构建产物里的值导入集合**，不是源码声明：

- `lib/**/*.js` 中作为值导入的宿主包，必须同时出现在 `peerDependencies`（声明对宿主的依赖）与 `devDependencies`（本地构建与测试用）。
- peer 范围逐一枚举**实际验证过的预发布线**（预发布版不落在通配范围内）：当前三个 dsh 包为 `^0.1.0-rc.6 || ^0.1.7-alpha.1`，cordis 为 `^4.0.1`，schemastery 为 `^3.18.1`。
- devDependencies 钉宿主正在运行的**精确版本**（cordis 4.0.3、dsh-* 0.1.7-alpha.1、schemastery 3.18.3），使编译期 API 面即运行期 API 面。
- 开发图中由自动 peer 安装留下的旧世代副本（dsh-invariants / dsh-scope / dsh-session / dsh-system-prompt / dsh-attachment / dsh-user-approval）由 `pnpm-workspace.yaml` 的 `overrides` 收敛到同一世代；该设置属根项目，不随包发布，消费方仍从自己的宿主解析。
- 宿主已提供的包**不进 `dependencies`**：那会在 profile 内再装一份，正是本规则要消除的双实例。
- `minimumReleaseAgeExclude` 对同一个包只能保留**一条**规则：多个版本条目会让该包的匹配失效（已实证），因此每包只列当前世代那一个版本。

当前清单——运行期值导入：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`；类型专用（不进 peer）：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-commands`。源码未引用的 `@deepseek-ai/dsh-system-prompt` 已从 devDependencies 移除。

lockfile 的 importers 段不记录 peerDependencies，peer 范围的增补不改 lockfile。

## Alternatives considered

- **devDependencies 停在 0.1.1-rc.2**：编译期看到的是两个月前的 API 面，0.1.7 的签名与词汇变更只能等运行期暴露。落败于本次实测：升级后 `tsc` 一次找出三处漂移。
- **peer 范围写成 `*` 或 `>=0.1.0-rc.6`**：`*` 不匹配任何预发布版，`>=0.1.0-rc.6` 同样因比较符元组规则挡掉 0.1.7-alpha.1，两者都表达不出真实契约。落败。
- **把世代收敛写进 `package.json` 的 `pnpm.overrides`**：那是发布物的一部分，语义上会被消费方误读为对宿主的要求。落败于根项目设置即可达意。
- **把内部 peer（dsh-invariants 等）加成显式 devDependencies**：等于把宿主内部实现写进本包清单，且每升一代都要改一遍。落败。
- **把 schemastery 放进 `dependencies` 或内联进 `lib/`**：前者在 profile 内再装一份、双实例照旧，后者需要打包链且仍与宿主不同源。落败。

## Consequences

收益：包在 profile 内安装与 `link:` 开发两种解析路径下都取宿主那一份依赖；编译期类型面与运行期 API 面同源，宿主漂移在 `tsc` 阶段暴露。

代价：devDependencies 与 lockfile 随宿主世代整体更新，升级粒度变粗；`minimumReleaseAgeExclude` 会随同日发布的世代增长（pnpm 在安装时自动追加）。版本范围表达的是"验证过的线"而非"能加载的线"，新增宿主世代需要显式加一段并跑一次编译期对账。

## Related

- 上游机制：`@deepseek-ai/dsh-app-boot` 的 `routeLinked`（linked root 按 `peerDependencies` 路由）与 `createRuntimeResolution`。
- 同类决定：`faf981e`（cordis / dsh-home-paths / dsh-llm / dsh-tools 升为 peer）。
- 本次对账定位到的代码级漂移：[2026-09-22-host-0-1-7-api-drift.md](../bug-fix/2026-09-22-host-0-1-7-api-drift.md)。
