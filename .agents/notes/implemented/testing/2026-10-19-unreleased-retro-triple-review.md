# Agent Note: 未发版区间回溯三重审核（v0.19.0..HEAD）与收口修复

Status: implemented

Review: FULL/2026-10-19#2/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

`v0.19.0..HEAD` 28 提交（P4-b→P6＋门禁移植批）落地时三重审核门禁尚不存在：各批只有机械门禁与测试，没有 R1/R2/R3 语义评审。发版前需要一次回溯三审，确认未发版代码在架构标准与总纲硬边界下干净。

## Decision

回溯批以 `v0.19.0` 为 base、`HEAD` 为 head 跑完整三重审核（简报门禁绿，tree 钉死；R1/R2 并行上限两路，R3 后置；只审不改，修不修用户定后再收口）：

- R1（简化面）0 Blocker / 0 Suggestion：eval 簇无重复、extraction 拆分干净（现状折叠反而违 P2 ADR）、search-query 无残留、写门单入口、14 新增件人人有生产消费者。
- R2（代码面）1 Blocker / 6 Suggestion：Blocker 为版本合并丢 `corrects` 边（`landMerge` 用提案级 link 直接插行，省略即 null；in-place 路径经 `COALESCE` 继承）→ 修为 `link ?? old.corrects`；S1 repoint 加 `status='active'`（归档指针冻结，文档本就写"live"）；S3 repeat 钳制 ≤2（合并本就是两两比）＋subset 钳制 30；S4 工具暴露 `runId`（同日重跑可保留多轮）；S5 版本 id 长度守卫（超限 fail closed）；S6 注释改述；S2（fixture cmd 沙箱）不修——威胁模型不成立（写 fixture 即已有写仓权限），复用架构审核 S1 结论。
- R3（文档面）0 Blocker / 10 Suggestion：design 三处（P6 分层/双读数/两段式）＋evals 标题＋proposed 四件前向指针＋RSI 的 D11 归宿与双月 60 天注记已修；README 两处挂账发版收尾（发版前数字必再变，现在同步等于做两遍）；60 天 vs 季度分歧以 P5a 拍板（双月 60 天）为准，RSI 四处"季度"同步作废。
- 第二轮：Blocker 修完后重走三审（R2 验轮核 Blocker＋S1/S3–S6 处置，R1/R3 首轮复核修复增量），全闭环后证据行落本 ADR 头区。
- 基线重定：预算棘轮（6 模块增行）与导出面快照（2 处 TSDoc）随修码 `--update`，同批 ADR 说明即本节；`EVAL_REPEAT_MAX` 刻意不导出（最小表面），`memory-merge` import 保持 type-only 独行（零装饰 churn）。

## Alternatives considered

- **只修 Blocker**：收口最小，但 S1/S3–S6 都是便宜可测的真问题，留着等于把已知 Blocker 级以下的问题带进发版。落败（用户 custom：逐条评审、该修都修）。
- **S2 一并加固（allowlist/沙箱）**：为不存在的攻击者付费，且 allowlist 本身要维护；威胁模型已由用户拍板。落败，挂账。
- **README 现在全量同步**：发版收尾（feature-flow 步骤 8）必再做一遍，现在同步做两遍。落败，挂账收尾。
- **不重审、直接发版**：Blocker 修码本身是新行为，没有第二轮确认等于评审开天窗。落败（用户 custom：有 Blocker，修完重审）。

## Consequences

- 版本合并与 in-place 的 `corrects` 语义单轨（省略即继承，无 unlink 路径）；归档行指针冻结，`followCorrects` 的"live"注释与实现一致。
- 评测工具面收敛：repeat 上限 2、subset 上限 30、`runId` 可自定义；超长 id 版本化 fail closed 而非落不可更新行。
- 文档同步做完可做的一半：design/evals/指针/RSI 已同步；README 同步与 S2 沙箱留到发版收尾/外部任务源出现时。
- 遗留（R2 验轮附带，不计 Blocker）：`eval-tools.ts` dry-run 分支的 subset 计数未钳制 30（真实执行已钳制），fixture 不足 30 条时不可观测，纯显示口径——下次动 eval-tools 时顺手对齐。
- 代价：快照与棘轮基线各重定一次（理由即本 ADR）；回溯两轮共 6 路子代理。

## Testing

- 新增 7 回归测试：merge 边继承/归档冻结/78 超限 fail-closed/77 边界、repeat=100 钳制两轮、runner 自定义 runId 落行、工具 runId 透传。
- 全套 991 测试绿；G3 21 门红绿俱验；`check:docs` 18 门绿；双 tsc＋lint 0 警告。
