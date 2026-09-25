# Agent Note: memory 专用 benchmark 与提取"不该记"清单

Status: implemented

## Problem

harness benchmark 评的是通用进化效果，没有"记忆提得准不准"的度量：precision（提的是不是参考事实）、recall（参考事实覆盖多少）、duplicate（本该 update 却 create）、stale（复活已知过时事实/删活事实）、noise（无关或禁区内容）都无处可测。对标基线 §6.5 要求至少这五个维度。同时提取 Prompt 只有正向规则，没有 ZCode 式的"不该记什么"排除清单，Git 历史、文件路径、临时状态都可能被当成记忆。

## Decision

- 新增 `src/memory-benchmark.ts`（纯函数，无模型调用）：`scoreMemoryExtraction(reference, edits, manifest)` 对提案逐条打分。参考事实用 `mustContain` 短语子串命中（中英同理、确定性）；`outdated` 事实被 create/update 复活计 stale、被 archive/delete 正确移除计 precision；create 命中 manifest（`mostSimilarEntry` + `CONFLICT_BLOCK_SCORE`）计 duplicate 且不计 precision；不命中任何事实计 noise，附原因（内容过薄 `<30` 字或命中 `MEMORY_NOISE_PATTERNS` 六条 v1 排除式：git 历史、commit hash、仓库路径、堆栈帧、临时状态措辞）。
- `precision = 有命中的 edits / 总 edits`（空提案 precision 为 1），`recall = 覆盖的 live 事实 / 全部 live 事实`（正确归档过时事实不刷 recall，避免"删得多分高"），`gradeMemoryScore` 按显式阈值判 pass（默认 precision/recall ≥ 0.7、duplicate/stale/noise 为 0）。
- `MEMORY_AGENT_SYSTEM_PROMPT` 追加 Do-not-remember 五条：仓库可重读的代码结构/路径、Git 历史与 CI 日志、项目指令文件已有内容、临时会话状态与一次性调试、无线索推测。
- 回归：`test/memory-benchmark.test.ts`（7 例：满分提案、部分召回、重复创建、复活过时/删活、噪声三形、空提案、显式阈值命名失败项）。

## Alternatives considered

- **用 LLM 当 judge 复用 harness benchmark**：每次评分烧模型调用且不确定；记忆形状评分是机械可判的（短语命中、相似度、排除式），确定性优先，拒绝。
- **reference 事实用 embedding 相似度**：引入向量依赖与阈值玄学；短语命中简单、可解释、套件作者可控，拒绝。
- **duplicate 沿用 warn 档（0.5）**：warn 档是"提示人看"，benchmark 要判"错"；block 档（0.8）与引擎 create 拦截同线，拒绝。
- **把"不该记"只放进 benchmark 排除式、不进 Prompt**：Prompt 是第一道防线（少烧 token），benchmark 是事后度量；两层都要，拒绝单层。
- **接 `/evolve benchmark-memory` 命令**：跑真实提取需要宿主 LLM 与回放样本（基线 §8.7 的另一半）；本次先落确定性评分器与 Prompt，命令接线待回放样本就绪，拒绝一次做大。

## Consequences

- 套件作者可手写"参考事实 + 提案"做回归；真实 transcript 回放样本与命令接线仍是后续工作。
- 排除式是 v1 启发式（注释中声明 trade-off），误伤案例走 benchmark 套件增补而非逐条调参。
