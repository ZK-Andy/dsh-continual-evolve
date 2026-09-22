# Agent Note: 宿主提供的运行期依赖统一声明为 peerDependencies

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

插件以 `dsh.bundle` 形态挂到 profile 下，运行期从宿主进程借包，但"哪些包算宿主提供"此前没有可审计的判据：`@deepseek-ai/schemastery` 是 `lib/index.js` 的运行期值导入，却只存在于 devDependencies，peerDependencies 里缺它。

两个后果。其一，profile 里可能同时存在两份 schemastery（宿主 3.18.3 / 本地锁 3.18.1），配置 schema 的类型与实例身份不一致。其二，dsh 0.1.7-alpha.1 起 profile 解析改为运行时拦截：位于 linked root（`link:` 到仓库目录的插件）的模块，只有被该目录的 `peerDependencies` 列名才路由到宿主副本，未列名者退化为沿插件目录向上原生查找；消费方只装发行包时，这条路径以 `ERR_MODULE_NOT_FOUND` 告终。

## Decision

判据是**构建产物里的值导入集合**，不是源码声明：

- `lib/**/*.js` 中作为值导入的宿主包，必须同时出现在 `peerDependencies`（声明对宿主的依赖）与 `devDependencies`（本地构建与测试用），二者的版本都必须是宿主实际能提供的范围。
- 仅以 `import type` 出现的宿主包不在此列：编译后擦除，不参与运行期解析。
- 宿主已提供的包**不进 `dependencies`**：那会在 profile 内再装一份，正是本规则要消除的双实例。

当前清单——运行期值导入：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`；类型专用（不声明）：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-commands`。

本变更据此把 `"@deepseek-ai/schemastery": "^3.18.1"` 补进 peerDependencies（该范围同时覆盖宿主 3.18.3 与本地 3.18.1）；lockfile 无变化，因为 pnpm v9 的 importers 段不记录 peerDependencies。

## Alternatives considered

- **放进 `dependencies`**：profile 内会再装一份 schemastery，双实例与身份不一致照旧。落败于同一理由，`faf981e` 对另外三个包已作同样否决。
- **不声明，靠 profile 本地候选或 installation scope 兜底**：对 pnpm 装进 profile 的插件确实可行（profile 层会回落到 installation scope 条目），但开发接线是 `link:`（linked root），只按 peer 路由；消费方拿不到本地副本时即解析失败。落败于解析路径不唯一。
- **把 schemastery 内联进 `lib/`**：需要引入打包链，且仍会得到与宿主不同源的 schema 实例。落败于成本与目标不符。

## Consequences

收益：发行包在 profile 内安装与 `link:` 开发两种解析路径下都取宿主那一份 schemastery；依赖契约与已有四个 peer 同源，可用"值导入集合 ⊆ peerDependencies"一条规则审计。

代价：peer 声明让 0.1.7-alpha.1 的拦截强制把本地 devDependencies 版本排除在运行期之外——插件的运行期 API 面等于宿主版本（当前 0.1.7-alpha.1，devDeps 仍是 0.1.1-rc.2）。因此宿主 API 漂移不能只靠编译期发现，跨版本升级时需额外跑一次真实会话回归。已核对本插件直接导入的符号（`defineTool`、`createUserMessage`、`BlockAssembler`、`ReasoningEffortId`、`Logger`、`expandHomePath`、`resolveDshHome`、schemastery 默认导出）与所用服务名（`tools`/`llm`/`systemPrompt`/`commands`/`goals`/`userQuestions`）在 0.1.7-alpha.1 中仍然存在。

## Related

- 上游机制：`@deepseek-ai/dsh-app-boot` 的 `routeLinked`（linked root 按 `peerDependencies` 路由）与 `createRuntimeResolution`。
- 同类决定：`faf981e`（cordis / dsh-home-paths / dsh-llm / dsh-tools 升为 peer）。
