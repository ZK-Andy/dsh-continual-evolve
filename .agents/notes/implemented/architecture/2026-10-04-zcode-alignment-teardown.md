# Agent Note: 终极收敛——完全对齐 ZCode（拆解记忆层与全部机制）

Status: implemented

## Problem

v0.11.0 发布后用户在实际使用中否定了整套"自进化"机制：模型读记忆仍在调 `evolve_list` 整仓 dump（全量会话日志真实调用 38 次）而非设计的 `evolve_recall`（6 次）；治理机制产生的主要交互是删除（delete 33 次 vs add 7 次）而非沉淀。根因复盘发现三件事：

1. **插件的前提假设是错的**：`memory-index.ts` 头注释称"store 在沙箱外、模型读工具打不开、所以只能注入"——对照 DSH 安装包源码（`dsh-fs-sandbox`：reads pass through untouched，所有模式都放行读；写围栏在 `workspace-write` 模式下只围工作区外），读路径从不设防。6k 预算、排序、降级、会话冻结这套注入机器解的是一个不存在的问题。
2. **层级是虚空的**：global 存量实为 4 条（HANDOFF 记载的 17 条是陈旧数字），local 层只是提取流水线的暂存区；ZCode 按"工作区"键分库，工作区多大记忆覆盖面就多大，人造的 global 层没有增量。
3. **治理在为不存在的场景付费**：单人使用下坏记忆就是工作区里一个 md 文件，手删成本趋近于零；版本/快照/审批/审计防的风险不随场景存在。"模型提议，代码保证"守护的价值从未被兑现过一次。

## Decision

**插件收缩为最小注入器，存储与读写完全对齐 ZCode：**

- 单一 store：`<工作区根>/.evolve/memory/`（`MEMORY.md` 索引 + 一事一文 md，ZCode 同款格式与 frontmatter）。工作区内点目录读写全通、免审批，零 DSH 改动。
- 开局注入：一个 system-prompt section（沿用 order 400 与 `memoryIndex.{enabled,guide,order,maxChars}` 配置）注入索引正文 + 记忆目录绝对路径 + when_to_save 指南；会话内冻结守 prompt cache；超预算截断并提示直接读目录。
- 模型用原生 Read/Write/Edit 直接操作记忆文件并维护索引；无任何专用工具、无 /evolve 命令面、无层级（global/local/project 全删）、无治理（快照/版本/回滚/审批/审计全删）、无后台提取、无 benchmark、无技能物化与热挂载。
- src 从 70 文件收缩到 3 文件（index / memory-section / memory-guide），测试从 58 文件收缩到 ~3。旧 `~/.dsh/evolve/` 已整体删除（同日用户指示），插件不再读写。

## Alternatives considered

- **只拆记忆层、prompt notes/skills 保留三层与治理**：层级是共享 store 代码（`HarnessScope` 穿约 18 个文件），只拆记忆层拆不干净，"虚空层级"仍留在内核，拒绝。
- **保留 benchmark/技能治理等非记忆子系统**：同一把尺子量下去，它们同样是单人场景下无人使用量的机制（benchmark 自 08-15 清理后零真实运行）；用户拍板"终极收敛"——全部删除或迁纯文件（技能本就是 SKILL.md 文件，AGENTS.md 本就是 ZCode 的 prompt notes），拒绝保留。
- **store 放 home 目录（`~/.dsh/memories/projects/<key>/`，ZCode 原版布局）**：读今天可行，但写会触发 DSH 内置提权弹窗（每次写记忆一次），零摩擦需改 DSH 核心 `writableRoots()`（跨仓库）；工作区内 `.evolve/` 当天全通，采用之，将来 DSH 补可写根后可再迁，拒绝现在跨仓库。
- **保留 evolve_add 等写工具、只删读工具**：写工具携带治理链（校验/快照/审批），留一个工具就留整套引擎；且 ZCode 证明原生写足够，拒绝。
- **沿用 2026-10-01 zcode-parity-boundary 的"治理不跟"边界**：该 ADR 的证据（命令使用量在治理类、v2 下坏记忆更需要回滚）被新证据推翻——命令使用量是机制自嗨的观测而非用户价值，坏记忆的正确归宿是工作区里可见可删的文件而非回滚器；本笔记 supersede 之。

## Consequences

- 插件定位重写："DSH 的工作区记忆——索引注入 + 原生文件读写，仅此而已"。npm 包名/repo 名保留（连续性），README/design/FAQ 全部重写。
- 索引由模型按指南维护，允许漂移（模型随时可读目录兜底，ZCode 同款取舍）；快照/回滚不再存在，坏记忆靠"文件可见 + 用户手删"兜底。
- 记忆不进版本库：bootstrap 在 git 仓库（cwd 有 `.git`）自动把 `.evolve/` 追加进工作区 `.gitignore`，非 git 工作区不碰任何文件；跨机器不同步（与 ZCode 一致）。
- workspace 的 HANDOFF 锚点改写：开场不再引用 `evolve_list global`；OBSERVATION 的机制观察项全部休眠；发版 v0.12.0 待用户验证拆解后行为再执行。
