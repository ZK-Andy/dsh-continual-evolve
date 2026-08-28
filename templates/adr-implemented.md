# Agent Note: <标题：动宾短句>

Status: implemented

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

> 放置路径：`.agents/notes/implemented/<class>/yyyy-mm-dd-<topic-title>.md`
> class ∈ {feature, bug-fix, simplification, architecture, process, testing}
> 日期 = 首次提出日（提案期定，迁移不改）。双语暂不启用，正文中文单语。
> 纪律：本文件用**现在时**描述已上线现实；代码移动/改名/改默认值时，同一变更中同步改写本文件（只改事实，不改决定）。

## Problem

动机，写脱离方案也能读懂的背景：现状是什么、痛点是什么、为什么需要改变。

## Decision

已落地的决定（现在时）：方案是什么、关键机制、边界与默认值。禁止 `## Proposal`/`## Plan`/`## Acceptance criteria` 等 spec 用语。

<!-- 按需添加自由格式的专属小节 -->
## Alternatives considered

> 强制小节：每个被认真考虑过的备选方案，用加粗首句的段落或 `### Why not <X>?` 小节记录"它是什么、为什么落败"。

- **备选方案 A**：…。落败原因：…

## Consequences

本决定付出的代价与买到的收益。可按需拆出现在时的 `## Testing` / `## Deferred` / `## Related` 小节。

---

<!-- 归档规则：决定完成且理由不再指导未来工作时，经 dsh-archive-agent-notes 流程移入 archived/<class>/，Status 下插入 "Archived: YYYY-MM-DD"，之后永久冻结（禁改/禁译/禁删）。 -->