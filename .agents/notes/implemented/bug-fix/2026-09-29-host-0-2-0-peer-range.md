# Agent Note: 0.2.0 世代宿主 peer 范围补齐

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

DSH 升到 `0.2.0-rc.2` 后，宿主插件门禁按 `peerDependencies` 把 `dsh-continual-evolve@0.10.2` 整个 bundle 跳过（`dsh --profile dotnet-desktop --dump-config` 首行 `skipping profile bundle`），`/evolve` 等能力随之消失；`evolve/plugin.log` 在宿主重启后不再出现 `mounted` 行。根因是三个 `dsh-*` peer 只声明到 `^0.1.0-rc.6 || ^0.1.7-rc.1`，而 `^0.1.x` 上限为 `<0.2.0-0`，天然排除 `0.2.0` 世代（semver 实测旧范围对 `0.2.0-rc.1/rc.2` 均为 `false`）。

## Decision

- 三个 peer（`dsh-home-paths` / `dsh-llm` / `dsh-tools`）统一追加 `|| ^0.2.0-rc.1`，覆盖 `rc.2` 与后续 `0.2` 稳定版，同时保留旧世代兼容；`cordis ^4.0.1` 与 `schemastery ^3.18.1` 在新宿主上仍满足，不动。
- `devDependencies` 与 `pnpm-workspace.yaml` 的 `overrides` 同步到 `0.2.0-rc.2`（`dsh-agent` / `dsh-commands` / `dsh-home-paths` / `dsh-llm` / `dsh-tools`；`schemastery 3.18.3→3.18.4`；`minimumReleaseAgeExclude` 里 `cosmokit 1.8.4→1.8.5`），使编译面与宿主运行面同代。
- 升级后 `typecheck`（src + scripts）零错误、`oxlint` 0 警告、`vitest` 58 文件 1075 例全绿，确认 `0.1.7-rc.1→0.2.0-rc.2` 在本插件用法面（`defineTool` / `ToolRunContext`、`dsh-llm` 消息构造、`home-paths` 解析、`cordis` Context）无契约漂移，`src/` 零改动。

## Alternatives considered

- **用 `allow-version` 精确豁免强跑旧包**：门禁放行但编译面仍停在旧世代，API 漂移无兜底，且每次重装都要重授。落败（仅作排查期的对照手段）。
- **peer 放宽到 `*` 或删除 peer 声明**：丢掉门禁的防 crash 价值，与 0.1.7 漂移教训（静默降级）相悖。落败。
- **只加 peer 范围、不升 devDeps/overrides**：门禁过了但类型对账仍在旧世代，下一次静默漂移抓不到。落败。
- **借机改 `src/`**：本次无漂移、无改的必要；越界改动违反 feature-flow。落败。

## Consequences

收益：门禁恢复加载；编译面与运行面同代，后续漂移继续由 `tsc` + 回归测试捕获。

代价：`dev` 面只跟最新世代，旧宿主行为回归需切 `overrides`（与既有"单世代钉死"策略一致）；`dotnet-desktop` 系 npm 实体拷贝，本修复需发新版并在桌面端更新后重启才生效（`web` 系软链，重编即生效）。

## Testing

- `tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.scripts.json --noEmit` 双过。
- `oxlint src test`：0 警告 0 错误。
- `vitest run`：58 文件 1075 例全绿。
- `pnpm check:docs`：四门禁全绿（含本笔记格式校验）。
- semver 实测：新范围对 `0.1.7-rc.1/rc.2` 保持 `true`，对 `0.2.0-rc.1/rc.2` 由 `false` 转 `true`。

## Related

- 上一代对账：[2026-09-22-host-0-1-7-api-drift.md](2026-09-22-host-0-1-7-api-drift.md)。
- 依赖契约策略：[2026-09-22-host-provided-peer-dependencies.md](../process/2026-09-22-host-provided-peer-dependencies.md)。
