# Agent Note: 重构基线——架构/编码规范 + 机器门禁 + B 裁决

Status: implemented

## Problem

三个时代（08 命令+治理 → 09 后台提取 → 10 对话化）的模块堆在同一棵依赖树上：`auto⇄fate`、`command⇄benchmark-command`、`command⇄mount-command` 三个循环依赖；`auto.ts`（981 行/出度 24）与 `command.ts`（637 行/出度 21）两个事实组装根；per-turn 后台提取与对话直写两代记忆生成路径并存。实测后台管道烧掉全部直调 LLM 的 90%（410/453 次）却只贡献 refinement 的 20%（20/100），落盘率 2%（426 次判断 8 次 applied）。规范只散在 AGENTS.md 口头约定里，无机器校验。

## Decision

以工作区评审包 `refactor-review-20261003/`（六份：架构规范/编码规范/两份治理审核/理念整合/分阶段计划）为依据，落地重构基线：

- **标准入仓**：`docs/architecture-standard.md`（五层模型、host-API 单点边界、组装根唯一、规模预算、时代残留退役规则、四条不变量）+ `docs/coding-standard.md`；AGENTS.md 只留指针与红线。
- **机器门禁**：`scripts/verify-architecture.ts` 接入 `run-gates`——层方向与 SCC 禁环、host 边界、L0/L1 包纯度、facade 绕过、行数/出度预算。现存违标进显式白名单（17 条，每条注明清偿 Phase），只减不增，清偿即删条目。
- **B 裁决采纳为执行计划**：保留专用 memory loop 提取内核，废除 per-turn 调度，改为压缩/收尾 drain/goal 受阻/手动 wrapup 四时刻驱动；删除 `fate.ts` 与死配置键；`command.ts` 纯路由化；`auto.ts` 拆分；超预算文件 Phase 3 拆分；Phase 4 重写 design.md 叙事；Phase 5 发版 v0.11.0。store 格式与审计语义全程不变。

## Alternatives considered

- **大爆炸重写**：丢弃 1110 个测试钉住的已验证治理引擎与真实用户数据，风险与"模型提议代码保证"的本体主张冲突，拒绝。
- **只做规范不做门禁**：口头标准在第四次转向时必然再次堆积（本次审核本身就是证据），拒绝。
- **门禁首日即硬卡所有违标**：会让 run-gates 常红数周，实际无人修；白名单 + 逐 Phase 清偿让违标可见、可清、可问责，采纳。
- **C 选项（后台管道维持现状）**：与 90% token 换 20% 产出、2% 落盘率的数据不符，拒绝。
- **A 选项（整删后台提取）**：丢掉跨轮模式捕获与 4608 行测试中的提取内核资产；时刻驱动以数量级降本保住能力，拒绝。

## Consequences

- 层归属唯一事实源是门禁的 `LAYER` 表；文件移动层 = 改表 + 改代码同一提交。
- `skillquality` 归 L1（纯逻辑 + 本地模板 IO）、`score` 归 L3（依赖 benchmark 类型）、`record-language`/`copy` 归 L2（host 语言链）——与评审包快照的差异以本文与门禁表为准。
- 后续 Phase 每阶段独立提交、打 `refactor/phase-N` tag、测试全绿；白名单条目随阶段清零，终态为空表硬门禁。
- 后台自动化年审纪律（规范 §5.5）自此生效：token 账与产出账对照 `reviews.jsonl`/`token-usage.jsonl`。
