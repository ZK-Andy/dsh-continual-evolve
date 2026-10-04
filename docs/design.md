# 设计：文件就是 store，代码只做注入

> 2026-10-04 终极收敛后的设计。此前的"一条循环"（三作用域 store + 治理机器 + 提取流水线 + benchmark）整体拆除，证据链与取舍见 ADR [`../.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md`](../.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md)（supersede `2026-10-01-zcode-parity-boundary`）；历史设计全文见冷归档 [`research/design-v1-2026-08-14.md`](research/design-v1-2026-08-14.md)，踩坑记录见 [`FAQ.md`](FAQ.md)。

## 核心主张

**文件就是 store，模型原生读写，代码只做一件事：开局把索引放进上下文。**

## 形态

```
<workspace>/.evolve/memory/
├── MEMORY.md          # 索引：一行一条「- [标题]（文件名.md）— 一句话钩子」
└── <fact>.md          # 一事一文：frontmatter（name/description/type）+ 正文
```

- **开局注入**（`src/memory-section.ts`）：`evolve:memory-index` section（order 400）注入索引正文 + 记忆目录绝对路径 + when_to_save 指南。会话内逐字节冻结守 prompt cache；索引超预算按整行截断并提示直接读目录；store 不存在时自动 bootstrap（mkdir + 起始索引）；guide 关闭且索引为空时零 token。
- **原生读写**：DSH 的读路径从不设防、写围栏只围工作区外（`dsh-fs-sandbox`：reads pass through untouched）——工作区内点目录读写全通、免审批。模型用原生 Read/Write/Edit 直接操作记忆文件并维护索引，插件不注册任何工具或命令。
- **指南随行**（`src/memory-guide.ts`）：when_to_save 分类学（user/feedback/project/reference，feedback 必带 Why + How to apply）、可重推导不存、相对日期转绝对、更新优先于新建、读时验证（引用前发现与现实不符当场修正或删除，超出 ZCode 的自加项）、[[名字]] 互引——改编自 ZCode 的持久记忆提示词。
- **零治理**：无快照/版本/回滚/审批/审计/提取/benchmark。坏记忆的归宿是工作区里一个可见的文件——删掉它就是退役（ZCode 同款取舍）。bootstrap 时若工作区是 git 仓库（cwd 有 `.git`），自动把 `.evolve/` 追加进工作区 `.gitignore`；非 git 工作区不碰任何文件。

## 为什么不是原来的样子（各一句话）

- **层级（global/project/local）**：ZCode 按工作区分库，工作区多大记忆覆盖面就多大；实测 global 存量只有 4 条，local 只是提取流水线的暂存区。
- **提取流水线**：per-turn → 四时刻 → 零，每一步都在砍成本直到价值归零；对话内顺手写已覆盖需求。
- **专用工具**：会话日志实测 38 次 `evolve_list` 整仓 dump 对 6 次 `evolve_recall`——注入正文之后模型本就不需要查询，工具只剩整仓 dump 一个用途。
- **治理机器**：为不存在的多人场景付费；单人场景下坏记忆手删十秒，快照/回滚/审批防的风险从未出现。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `memoryIndex.enabled` | `true` | 注册记忆 section |
| `memoryIndex.guide` | `true` | 注入 when_to_save 指南（关闭且索引为空时该 section 零 token） |
| `memoryIndex.order` | `400` | section 顺序（上游命名槽位自 `PLAN_POLICY=500` 起） |
| `memoryIndex.maxChars` | `6000` | 注入索引的硬字符预算 |

## 设计来源

- **ZCode 记忆系统**：唯一的蓝本——按工作区分库、`MEMORY.md` 索引 + 一事一文、开局注入索引、原生读写、when_to_save 指南（源码级分析见 [`research/zcode-memory-parity-analysis.md`](research/zcode-memory-parity-analysis.md)）。
- 历史血统（penguin-harness / prime-agent `/refine` / 学术）随机制一并退役，记录见冷归档。
