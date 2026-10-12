# Agent Note: 技能使用回路 V2——取用记账、剪枝证据、自进化信号

Status: implemented

> 放置路径：`.agents/notes/implemented/architecture/2026-10-12-skill-usage-loop-v2.md`
> 前序：`.agents/notes/implemented/feature/2026-10-11-skill-wiring-s1.md`（S1）；2026-10-12 会话结论：宿主自带技能发现 + 懒加载（本会话 catalog 秒级更新实证），插件侧索引注入是重复功能，V2 改做使用回路。

## Problem

S1 建好了技能的存与看，但插件对“用”一无所知：技能经由宿主发现、`skill_read`、卡片预览三条路被消费，没有任何一条留下使用记录。后果有二：① `.agents/AGENTS.md` 的剪枝规则（触发过 ≥1 次者保留）永远没有证据，只能凭感觉；② 自进化缺“沉淀是否有用”的信号——提取轨知道写了什么，不知道什么真被用过，闭环断在反馈边。

## Decision

V2 只补可观测，不碰加载（零重复、零双份 token）：

- **取用记账**：`skill_read` 按 id 取回正文命中时记一笔（`src/skill-tools.ts`）；卡片技能预览端点命中时记一笔（`src/card-routes.ts`）。只记正文取回（真消费），检索/列表不记（噪声）。
- **聚合存储，无无界表**：新表 `skill_usage`，主键 `(workspace_id, skill_id, scope)`，字段只有 `use_count` + `last_used_at`（`src/store.ts` DDL，新表随建库语句覆盖旧库，无需 ALTER）。每次取用 upsert +1，无行增长、无需裁决。
- **记账永不打断读**：写账本失败吞掉、原样返回正文（与“文件同步永不 fail 整批”同纪律）；`getSkillUse` 失败返回 undefined，快照降级为 0/null。
- **投影只读**：卡片技能列表加 `useCount`/`lastUsedAt` 两列（`src/memory-snapshot.ts` `SkillFileInfo`，client 行内展示“用过 N 次”，双语）；剪枝时按此排序。
- **测试**：264 测试（含 6 个新增使用回路回归）/ typecheck / lint / 文档门禁全绿；覆盖率水位守住（per-file 91/91/100/83）。

## Alternatives considered

- **插件侧索引注入（本 ADR 第一版）**：与宿主技能目录重复，模型看两份、花双份 token。2026-10-12 会话内被否，见前序。
- **全 body 开局注入**：单条 64KB 上限可吃光预算，违背按需。落败。
- **宿主侧埋点（宿主 loader 打点）**：插件够不着宿主 skill loader，没有合法位。落败。
- **记检索/列表命中**：列表一刷全记，全是噪声，用≠看。落败，只记正文取回。
- **明细账本（每次取用一行）**：无界增长又要裁决；聚合计数已够剪枝与信号用。落败。
- **实时拦截改写**：2026-10-08 已判死刑，不重议。

## Consequences

- 取用可观测：`skill_read`/卡片预览命中即 +1（含 scope 区分）；剪枝规则第一次有证据可用。
- 代价：`skill_usage` 聚合表（有界，无需裁决）；快照多两次查表（失败降级 0/null）。
- 诚实边界：宿主目录直读 skill 正文（模型走宿主 loader 不经过插件）记不到——本回路只覆盖插件可观测面，数字是下界；README 如实写，不夸大。
- 验证：264 测试 / typecheck / lint / 文档门禁全绿；双语 README 同步（取用计数行为 + 264 徽章）。
