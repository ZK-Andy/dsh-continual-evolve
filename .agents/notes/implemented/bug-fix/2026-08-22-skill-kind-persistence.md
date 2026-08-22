# Agent Note: 修复 skill_kind 在状态重载时被静默丢弃

Status: implemented

## Problem

`loadHarnessState` 按字段白名单逐项重建条目，但漏掉了 `skill_kind`：任何一次"落盘 → 重载"往返都会把条目的 guidance/executable 形态抹成 undefined。受影响面：`/evolve mount` 的物化形态判定与列表渲染的 `[guidance]` 标签在重载后全部失真；mount 因存在 `|| reference 为空` 的兜底而部分掩盖了症状。引擎级测试（evolve_add 落盘后断言 `skill_kind`）抓出了该缺陷。

## Decision

`loadHarnessState` 在重建条目时透传合法的 `skill_kind`（仅接受 `"guidance"` / `"executable"`，其余值丢弃以维持类型契约）；缺失时保持 undefined（executable 语义为默认，兼容全部存量数据）。文件格式无变化——此前写入磁盘的 `skill_kind` 字段本就存在，只是读取端从未消费。

## Alternatives considered

- **在 `saveHarnessState` 端做字段过滤并同步维护 `ENTRY_KEYS` 白名单**。落败原因：ENTRY_KEYS 本就是无人引用的死代码，再引入一套白名单等于两处真相；问题只在读取端少读了一个已持久化的字段，一行透传即修复。
- **把 `skill_kind` 合并入 metadata**。落败原因：改变持久化 wire 格式，需要迁移存量文件，且 render/mount/validate 的现有读取点全要跟着改；收益为零。

## Consequences

换来：guidance/executable 形态跨会话、跨重启稳定；`evolve_add` 工具创建的技能条目经重载后形态保真。付出：无——纯读取端补齐，无迁移、无格式变更。

## Testing

`test/tool.test.ts` 的 skill 用例断言 `skill_kind` 经真实引擎落盘重载后保真；`pnpm test` 501 例全绿。
