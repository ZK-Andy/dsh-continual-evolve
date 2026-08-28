# Agent Note: <标题：动宾短句，如 "extract-example-app-packages">

Status: proposed

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 放置路径：`.agents/notes/proposed/<class>/yyyy-mm-dd-<topic-title>.md`
> class ∈ {feature, bug-fix, simplification, architecture, process, testing}
> 日期 = 首次提出日。中英双语成对（.md + .zh.md），结构逐节对应。

## Problem

动机，写脱离方案也能读懂的背景：现状是什么、痛点是什么、为什么需要改变。不在此节提解决方案。

## Proposal

拟议的变更。计划、迁移步骤、开放问题属于这里（提案期允许未来时态）。

<!-- 按需添加自由格式的专属小节：包拓扑、wire 契约、schema 等 -->
## Alternatives considered

> 强制小节：每个被认真考虑过的备选方案，用加粗首句的段落或 `### Why not <X>?` 小节记录"它是什么、为什么落败"。不记录比赢过什么的决定，必然招致重新辩论。

- **备选方案 A**：…。落败原因：…
- **备选方案 B**：…。落败原因：…

## Acceptance criteria

可观察的"完成"状态：什么行为/状态意味着落地完成。

## Risks

可能出错的地方，以及本变更明知要放弃什么。

---

<!-- 归档/状态迁移规则：
proposed → implemented：Status 改 implemented、移入 implemented/<class>/，## Proposal 改写为现在时的 ## Decision，Acceptance criteria/Risks 折叠进 ## Consequences（或现在时的 ## Testing/## Verification）。
proposed → rejected：Status 改为 "rejected — <一行理由>"，文件冻结。
归档：移入 archived/<class>/，Status 下插入 "Archived: YYYY-MM-DD"，之后永久冻结。 -->