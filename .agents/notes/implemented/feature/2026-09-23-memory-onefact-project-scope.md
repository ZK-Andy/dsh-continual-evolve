# Agent Note: memory-onefact-project-scope

Status: implemented

## Problem

记忆 kind 持续鸡肋，两个根因（对标 `zai-org/ZCode` 记忆系统确认）：

- **无形状纪律**：`memory` 条目 title/content 自由文本，无类型、无单条原子要求、无踩坑结构（Why/How）。`evolve_add` 连 `metadata` 参数都不收，模型想分类也无处写。写进来的东西检索时标题党、正文杂糅，`BM25` 排出来也不可用。
- **缺项目层**：`HarnessScope` 只有 `local | global`。`local` 是单会话暂存（不出本会话的内容本来就在上下文里，做检索层是自我重复），`global` 跨全部项目（项目专有知识会污染每个未来会话）。ZCode 只有 `project`（workspace 路径哈希目录）与 `user`（全局）两层检索，session 只以 `originSessionId` 审计戳存在，不做存储 scope。

## Decision

抄 ZCode 语义、留 JSON 存储（不迁 md 文件），三段接线：

- **写约束（`validate.ts` 咽喉）**：`memory` 的 `create` 必须带 `metadata.memoryType ∈ user | feedback | project | reference`（`MEMORY_TYPE_KEY = "memoryType"`）；`feedback`/`project` 的 `create` 正文必须同时含 Why 与 How 标记（踩坑结构）；`update` 携带 `memoryType` 时同样校验合法性。`evolve_add`/`evolve_update` 新增 `memoryType` 参数（`scope` 字符串参数与既有 `global` 布尔并存，`scope` 优先）。
- **三层 scope（`local | project | global`）**：`local` 降级为晋升暂存箱（只写不注的语义不变，注入照旧合并）；`project` 落盘 `evolve/projects/<slug-hash>/`，key 由 `resolveProjectKey(workspacePath, workspaceIdentity?)`（slug + sha256-16，与 ZCode `project-root.ts` 同构）计算，`sessionId` 参数在 project 下即 key（`store.ts` 消毒防穿越）；`state.ts` 归一化接受 `project`，`mergeHarnessStates(global, local?, { projectState? })` 按 global < project < local 合并，碰撞分别冠 `project:`/`local:` 前缀。project key 优先显式 `opts.projectKey`，否则从 assembling agent 的 `session.header.cwd` 蚊子腿派生（`projectKeyOf`，duck-type，拿不到就退回 global+local）。
- **检索只注索引**：不给 memory 加内容节（索引路线，不是 top-N 内容路线）。目录行 memory 升级为 `- [memory:type:id] title`（type 即检索钩子的一部分），目录排序从字典序换成 `rankEntries(all, relevanceQuery)`，截断线下掉的是不相关条目。`local` 暂存语义下 wrapup 晋升目标仍是 global（project 晋升 deferred）；`filterPromotable` 对无 `memoryType` 的 memory 候选以可行动理由跳过（先补类型再晋升），不静默默认。
- **审批**：project 写与 global 同门（`requireGlobalApproval`，同 flag，不新增配置项），理由是 project 同样跨会话。
- **`validateBlastRadiusScope`**：project scope 要求 `blastRadius` 为 `project` 或 `general`（`session` 与持久化矛盾）。

## Alternatives considered

- **memory 加 top-N 内容节（每轮 +3×180 字）**：与 ZCode 的索引路线互斥。内容节把召回压力放在注入排序上，索引行标题党问题不解决；索引钩子（type+title 纪律）+ 按需 `evolve_list` 全文的 token 更省且可解释。否决内容节，保留目录索引。
- **local 宽松、仅 project/global 严格（双契约）**：能少改约 30 处存量测试，但模型要在两种记忆契约间切换，且晋升时要修补缺失类型（assessor 负担 + `promote` 载荷加字段）。统一严格契约一句话可讲清，存量测试机械补 `memoryType` 即可。否决双契约。
- **缺失 memoryType 静默默认 `reference`**：违反 fail loud，且把分类负担推给检索侧；晋升守卫同样无法区分"作者判定为 reference"与"作者没写"。否决，缺失即拒绝并给出可行动错误。
- **project key 存裸路径**：路径含用户主目录、大小写/符号在 win32 下不稳定，且目录名直接进文件系统。否决，采用 slug-hash（与 ZCode 同构）。
- **local 移出注入合并**：local 仍有"本会话进行中"的即时价值（门禁 review/plan 读它），且 wrapup/usage 计数依赖注入可见性。v1 保留合并，只在文档上明确其暂存箱定位。

## Consequences

- 存量 `memory` 条目（无 `memoryType`）仍可读可注；新建必须分类；晋升时无类型者被跳过并提示补类型（一次性迁移成本）。
- `mergeHarnessStates` 新增可选第三位 opts 对象，老二元调用零改动；`formatEntriesDirectoryCapped` 签名不变（内部走 relevance 排序），`entriesSectionText` 新增可选 `projectKey`。
- `header.cwd` 派生是 best-effort：拿不到时 project 层静默缺席（与空 store 同构），`projectKeyOf` 永不抛。
- Deferred：wrapup/fate 向 project 的晋升、`memoryDescription` 独立钩子字段、project 已提交/私人区分（对标 ZCode `.zcode/agent-memory` vs `agent-memory-local`）。

## Testing

- `test/project.test.ts`（新增）：`resolveProjectKey` 稳定性/区分性、`projectKeyOf` duck-type 与防御、`storePaths` project 落盘与穿越消毒。
- `test/validate.test.ts`：memory create 缺类型拒绝、非法类型拒绝、feedback 缺 Why/How 拒绝、update 携非法类型拒绝、project scope 的 blastRadius 门。
- `test/state.test.ts`：三层合并优先级与 `project:`/`local:` 碰撞前缀。
- `test/inject.test.ts`：目录 relevance 排序截断、memory 行 type 钩子、`entriesSectionText` 的 project 合并。
- 存量测试：memory create 补 `metadata: { memoryType: "reference" }`（或上下文贴切类型）。

## Related

- [zai-org/ZCode](https://github.com/zai-org/ZCode)：`apps/zcode-cli/packages/core/src/context/sections/memory.ts`（一条一文件 + 四类型 + Why/How）、`memory/project-root.ts`（slug-hash）、`memory/recall/manifest.ts`（索引行）、`runtime/helpers/project-memory.ts`。
- [entry-valence-feedback](2026-08-28-entry-valence-feedback.md)：`valenceNegative` 与 `memoryType` 同为元数据键封闭集成员，`feedback` 类型是 contradicted 的主要生产者。
- [write-time-conflict-guard](2026-08-24-write-time-conflict-guard.md)："已存在就 update 别新建"与 one-fact 原子性同源。
