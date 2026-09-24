# ZCode Memory 对标与 DSH 持续进化记忆闭环分析

> 调研日期：2026-09-24。本文是当前“自动 review 运行时开关与 ZCode 节奏对齐”待办的实现基线。进行相关实现前必须先读本文；以本文的 P0 验收条件为准，不要只把固定轮数从 6 改成 1。
>
> 范围：`dsh-continual-evolve` 的自动记忆提取、存储、召回、质量评估与运行时控制；不涉及替换 DSH 已有的版本化、回滚、审计和作用域能力。

## 1. 结论摘要

ZCode 的高质量记忆效果不是单靠机械门禁，而是以下闭环共同作用：

```text
每个成功 turn 后调度
→ 轻量 eligibility 过滤
→ 增量 snapshot + cursor
→ 后台串行 scheduler 合并最新 pending
→ 专用且受限的 Memory Extraction Agent
→ 已有记忆 manifest + update-first
→ 一个事实一个记忆 + 索引
→ 后续会话目录召回/按需读取
```

对 DSH 而言，固定 `reviewIntervalTurns` 不应继续作为正常记忆提取的主触发条件。应改成“每个成功 turn 产生候选 snapshot，先过滤，再由后台调度器处理”的 ZCode 式节奏。

DSH 当前已经具备、且不应为了模仿 ZCode 而删除的能力包括：local/project/global 三作用域、版本化、快照、确定性回滚、审计、CJK BM25 相关性排序、负反馈降权、注入预算、来源 provenance、人工审批和 benchmark 基础设施。

真正欠缺的是提取运行时闭环、专用提取器、增量 checkpoint、定向召回、可读存储投影和 memory 专用质量评估。

## 2. ZCode 实现证据

### 2.1 每个成功 turn 后调度，而不是固定 N 轮

ZCode 在主会话成功完成一轮后调用 `scheduleProjectMemoryExtraction`，除非该次执行显式传入 `memoryExtraction: "skip"`。

源码：

- [`turn.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts)
- [`project-memory-extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts)

这里的“每轮”是成功 turn 的调度边界，不是每 6 轮，也不是每次工具调用。

### 2.2 调度前有机械 eligibility 过滤

ZCode 的 `extraction.ts` 在调用模型前检查：

- 是否存在直接写入 Memory 的工具调用；已有直接写入则跳过，避免重复提取；
- 是否存在真实、非 synthetic、非 model-only 的用户文本；
- 用户文本是否达到最小词数门槛；
- 是否是远程工作区、headless 或内部执行；
- 当前是否已有提取任务，是否只需要保留最新 pending snapshot。

源码：[`extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/extraction.ts)

这层主要解决噪声、成本和重复写入，不负责判断一条信息是否真的有长期价值。

### 2.3 使用增量 cursor

ZCode 在 scheduler 中保存已处理边界 `MessageId`。成功提取或确认 no-op 后推进 cursor；提取失败或中止时不推进，后续 snapshot 可以重试。

每次提取只处理 cursor 之后的新消息，而不是重复提交整个会话。提取时还会按当前有效会话分支选择消息，避免 rewind/fork 后把错误分支写入记忆。

### 2.4 后台 scheduler 合并突发 snapshot

ZCode 的 scheduler 具有以下行为：

- 没有运行任务时，开始处理当前 snapshot；
- 已有任务时，只保存最新的 pending snapshot；
- 当前任务结束后，优先处理最新 pending，而不是为每个 turn 启动一个并发任务；
- session shutdown 时 abort scheduler；
- 普通关闭路径有有界 drain，benchmark 等特殊路径可以等待自然结束。

因此 ZCode 同时具备“每轮触发”和“不会因每轮触发而无限并发”的性质。

### 2.5 专用、受限的 Memory Extraction Agent

ZCode 启动独立的后台 memory agent loop，最多运行 5 个内部 turn。允许：

- `Read`、`Grep`、`Glob`；
- 只读 Bash；
- 在 memory 根目录内 `Write` / `Edit`；
- 删除 memory 目录内符合安全规则的 Markdown 文件。

禁止：

- `Agent`；
- MCP 工具；
- 网络工具；
- 项目代码写入；
- memory 目录之外的写操作。

源码：[`memory-agent-loop.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts)

这个 Agent 是 transcript 的消费者，不是主会话状态的替代品；它不能把自己的请求写回主会话的 rollout 轨迹。

### 2.6 先读已有记忆，再决定创建还是更新

ZCode 在提取前扫描已有 memory manifest，至少向提取 Agent 提供：

- 文件名；
- memory type；
- description；
- 最近修改时间。

提取 Prompt 明确要求先检查已有记忆，优先更新已有文件，不要创建重复条目。

源码：

- [`manifest.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/recall/manifest.ts)
- [`project-memory-extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts)

### 2.7 四类记忆与“不该记什么”

ZCode 的 Memory Prompt 明确区分：

- `user`：用户身份、偏好、专长；
- `feedback`：用户对 Agent 工作方式的纠正和确认，包含 Why / How to apply；
- `project`：项目目标、约束、背景和进展，包含 Why / How to apply；
- `reference`：外部系统、文档、Issue、看板等入口。

同时明确排除：

- 代码结构、项目架构、文件路径等可从仓库重新读取的信息；
- Git 历史和最近变更；
- 已经写在项目指令文件中的内容；
- 只对当前对话有效的临时状态；
- 一次性调试过程和当前任务进度。

还要求：

- 一条记忆只表达一个事实；
- 记忆文件使用 frontmatter；
- `MEMORY.md` 只做一行一条的索引；
- 优先更新、删除过时记忆；
- 记忆可能过时，真正据此采取行动前要重新验证。

源码：

- [`persistent-memory-prompt.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts)
- [`context/sections/memory.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/context/sections/memory.ts)

### 2.8 一个事实一个文件，索引负责召回

ZCode 的项目记忆目录形态为：

```text
~/.zcode/cli/memories/projects/<project>/memory/
├── MEMORY.md
├── user-prefers-pnpm.md
├── feedback-no-unrelated-lint.md
└── project-release-constraints.md
```

项目身份通过 workspace path 或 workspace identity 哈希隔离。索引有大小上限，事实文件保留完整内容。

源码：

- [`project-root.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/project-root.ts)
- [`index-content.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/index-content.ts)

## 3. DSH 当前基线

### 3.1 已有能力

当前 DSH 已具备：

- 结构化 `prompt/memory/skill/subagent` 条目；
- `user/feedback/project/reference` memory type；
- feedback/project 的 Why + How 约束；
- local/project/global 作用域；
- 来源会话和来源 seq；
- 版本、快照、确定性回滚；
- append-only refinement history 和 reviews 审计；
- project/global 人工审批；
- CJK bigram + BM25 相关性排序；
- recency 和 negative valence 排序信号；
- 注入目录上限和 token 预算；
- injection usage 统计；
- `evolve_list/add/update/delete/rollback` 工具；
- `/evolve status/usage/history/rollback` 等命令；
- benchmark、自动回归 case 和失败审计。

相关实现：

- [`inject.ts`](https://github.com/ZK-Andy/dsh-continual-evolve/blob/main/src/inject.ts)
- [`search.ts`](https://github.com/ZK-Andy/dsh-continual-evolve/blob/main/src/search.ts)
- [`types.ts`](https://github.com/ZK-Andy/dsh-continual-evolve/blob/main/src/types.ts)
- [`store.ts`](https://github.com/ZK-Andy/dsh-continual-evolve/blob/main/src/store.ts)
- [`tool.ts`](https://github.com/ZK-Andy/dsh-continual-evolve/blob/main/src/tool.ts)

### 3.2 主要缺口

| 能力 | DSH 当前状态 | 优先级 |
|---|---|---|
| 每轮增量 snapshot 调度 | 仍以固定回合门禁为主 | P0 |
| 提取 cursor/checkpoint | 只有来源 seq，不是提取完成边界 | P0 |
| eligibility 过滤 | 有部分轨迹/门禁判断，但不是 ZCode 式 turn snapshot 过滤 | P0 |
| 专用 Memory Agent | 通用 review/planner 管线 | P0 |
| 已有记忆 manifest | Planner 能看到状态，但没有专用 manifest 提取协议 | P0 |
| pending snapshot 合并 | 有 running 防重入，但没有 ZCode 式 latest-pending scheduler | P0 |
| 动态 enable/disable | 目前是静态 `autoReview` + runtime pause | P0 |
| 定向召回 | 目录 + 完整 `evolve_list`，缺少 query/filter/limit 的精确读取工具 | P1 |
| 可读 Markdown 投影 | JSON store 为主，没有 ZCode 式 `MEMORY.md` + fact files 投影 | P1 |
| 提取质量 benchmark | 有 harness benchmark，但缺少 memory precision/recall/noise 评估 | P1 |
| 生命周期 drain/cancel | gate 有 fire-and-forget，缺少提取 scheduler 的完整 drain/abort | P0 |
| 提取回执 | 有成功应用后的 gate notice，但缺少 no-op/skip/更新的统一回执 | P1 |
| 事实类型与 prompt | Planner 有规则，缺少独立 Memory Extraction Prompt | P0 |

## 4. DSH 对标后的目标架构

```text
成功 TurnComplete
        ↓
捕获当前有效消息边界和增量 snapshot
        ↓
Eligibility 机械过滤
        ↓
Snapshot Scheduler
  - 单实例串行执行
  - 只保留最新 pending snapshot
  - 失败不推进 cursor
  - shutdown 可 abort，关闭时有界 drain
        ↓
专用 Memory Extraction Agent
  - 只读取新增消息
  - 读取已有 memory manifest
  - 最多 5 个内部 turn
  - 只能提出/应用 memory 变更
        ↓
结构化 proposal
        ↓
机械校验
  - 一条事实
  - memoryType
  - feedback/project Why + How
  - 作用域与 blast radius
  - 来源证据
  - 重复/冲突/过时检查
        ↓
EvolutionEngine apply
  - local 自动应用
  - project/global 保留人工审批
  - snapshot/version/audit/rollback
        ↓
JSON store + 可读 Markdown 投影
        ↓
目录发现 + BM25 排序 + 定向 recall
```

### 4.1 触发与调度

- 正常路径不再以 `reviewIntervalTurns` 作为 memory extraction 的主门槛。
- 每个成功 turn 都可以产生一个候选 snapshot。
- scheduler 必须串行；运行期间的多个 snapshot 合并为最新 pending snapshot。
- snapshot 必须包含：session/project identity、有效分支、消息边界、用户文本摘要、已有 manifest 摘要、runtime 状态。
- 提取失败、abort 或超时不得推进 cursor。
- compaction 可以保留为强制 flush/故障兜底，但不能取代正常每轮调度。

### 4.2 Memory 专用提取器

提取器只负责 memory，不负责自动生成 prompt、skill 或 subagent。通用 `/evolve` 仍可保留，用于显式规划和其它 kind。

提取器必须：

- 使用独立、受限的模型/工具上下文；
- 读取最近新增消息，而不是重新吞整个会话；
- 读取已有 memory manifest；
- 优先 update/archive，而不是重复 create；
- 允许用户显式“记住/忘掉”走立即路径；
- 无内容时返回 no-op，不产生空更新。

### 4.3 存储策略

保留 DSH JSON store 作为唯一事实源，不直接用 Markdown 取代它。增加可读投影：

```text
JSON harness state（事实源、版本、回滚）
        ↓ materialize
MEMORY.md（索引）
memory/<fact-id>.md（单事实可读文件）
```

投影必须由 store 成功应用后自动生成，回滚/归档时同步更新；模型不能绕过 engine 直接写投影。

### 4.4 召回策略

保留当前 CJK BM25、recency、negative valence 和 token cap，并补一个定向召回面：

```text
evolve_recall({
  query,
  kinds,
  scopes,
  memoryTypes,
  limit
})
```

目录继续负责低成本发现；`evolve_recall` 负责返回相关条目的完整内容、来源、版本和可能过时状态；`evolve_list` 继续负责完整管理视图。

## 5. P0 验收条件

实现相关功能时，必须至少满足：

1. 固定回合数不再是正常 memory extraction 的必要条件。
2. 每个成功 turn 都能产生可追踪的 snapshot 或明确 skip 记录。
3. 无真实用户文本、已直接写 memory、内部/远程 turn 能被机械跳过。
4. 提取 scheduler 串行运行，突发 turn 只保留最新 pending snapshot。
5. 提取失败/abort 不推进 cursor；后续 snapshot 可以重试。
6. 提取 Agent 只能修改 memory 范围，不能修改项目代码或调用外部 Agent/MCP。
7. 提取前能拿到已有 memory manifest，并优先 update/archive。
8. memory create 仍强制一条事实、memoryType、Why/How 规则和来源证据。
9. `/evolve resume` 与 `/evolve pause` 能即时改变运行时状态，不要求修改 profile 或重启。
10. local/project/global 的审批、快照、回滚和审计语义保持不变。
11. 召回不把完整大 store 无条件塞进上下文；必须有目录或定向读取上限。
12. 增加 scheduler、cursor、eligibility、权限边界、动态开关和失败重试回归测试。

## 6. P1 验收条件

1. 有可读的 `MEMORY.md` 和单事实 Markdown 投影。
2. 有 query/kind/scope/type/limit 过滤的定向 recall。
3. 有 memory 专用提取 Prompt，并明确“不该记什么”。
4. 有 no-op/skip/update/create 的统一提取回执。
5. 有 memory 专用 benchmark，至少测 precision、recall、duplicate、stale、noise。
6. 有手动 remember/forget 路径，并能定位、更新、删除已有记忆。
7. 有 per-turn 提取的 token、耗时、成功/失败/no-op 统计。

## 7. 保留 DSH 的差异化能力

不要为了复制 ZCode 而删除：

- local/project/global 三作用域；
- project/global 人工审批；
- 结构化 JSON 事实源；
- 版本、快照、refinement history 和确定性回滚；
- CJK BM25 相关性排序；
- negative valence 和 stale 降权；
- injection usage、token ledger 和容量上限；
- benchmark、auto regression 和失败审计；
- skill/subagent/prompt 等 DSH 特有的 harness state。

ZCode 的 Markdown 文件布局可以作为可读投影和用户信任层，不应削弱 DSH 的治理层。

## 8. 推荐实施顺序

1. 先抽离并测试 snapshot/cursor/eligibility 数据模型。
2. 实现串行 latest-pending scheduler，覆盖并发、失败、abort、drain。
3. 将 `/evolve pause|resume|status` 改成真正的运行时 enable/disable。
4. 增加 Memory 专用 extraction prompt 和受限执行上下文。
5. 将 memory manifest、update-first 和 no-op 语义接入提取器。
6. 增加定向 recall，再增加 Markdown 投影。
7. 建立 memory 专用 benchmark 和真实会话回放样本。
8. 最后再决定是否把通用 planner 的 memory 分支复用或完全独立。

## 9. 来源

- [ZCode Memory 官方文档](https://zcode.z.ai/cn/docs/memory)
- [ZCode GitHub 仓库](https://github.com/zai-org/ZCode)
- [`turn.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts)
- [`project-memory-extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts)
- [`extraction.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/extraction.ts)
- [`memory-agent-loop.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts)
- [`persistent-memory-prompt.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts)
- [`manifest.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/memory/recall/manifest.ts)
- [`context/sections/memory.ts`](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/context/sections/memory.ts)
