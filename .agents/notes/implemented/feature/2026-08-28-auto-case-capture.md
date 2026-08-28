# Agent Note: auto-case-capture

Status: implemented

## Problem

进化失败（benchmark 拒绝候选并回滚、门禁提案未获同意）之后只留下审计记录——触发失败的那段轨迹没有沉淀为回归资产，同一失败可以无成本地重复发生。benchmark case 全靠手工添加（`add-case`），这正是 dsh-auto-evolve 用「沙箱 episode 回放」自动化掉的环节（机制同构度最高的原因），也是 D2 继承度量缺数据源的根源。见 `docs/research/pi-dsh-competitor-gap-analysis.md` §5.2 P1-3。

## Decision

新增 `src/autocase.ts`：`captureAutoCase` 把失败尝试机械转成 **draft 状态的 benchmark case**（statement 脚手架 + 脚手架 rubric，加密落盘），两个触发点接线——

- **benchmark_rejection**（benchmark-command run）：决策 REJECTED 后（无论是否 autoRollback），把 `decision.reasons`、候选 id、会话 id 落进脚手架。
- **gate_no_consent**（auto 门禁）：规划产出了编辑但全部未获同意（含 skill 提案被扣）的 declined 分支，把 proposal summary 与 review rationale 落进脚手架。

关键边界：

- **容器隔离**：capture 一律进专用容器 benchmark `auto_regression`（首次自动创建），**绝不进用户 benchmark**——run 路径按容器全量选 case、不过滤 status，脚手架 rubric 若混进真实基准会被当成真评分标准评估。人工把有价值的 capture 迁入真实基准（重写 statement/rubric → casecheck → pilot → freeze）后才进入闭环。
- ** rubric key 显式传递**：capture 必须用安装实例的 resolved key 加密（dev fallback 的密文真 key 解不开，脚手架会变废纸）；`AutoReviewConfig` / `CommandRuntimeOptions` 各带一份。
- **确定性触发点**：`!review.shouldRefine` 的 declined（"无需进化"）不是失败，不触发；apply 成功的 approved 不触发。只有"尝试过进化且失败"才 capture。
- **包含性**：capture 是支线任务，两个触发点都 try/catch 包住（fail-into-log），失败绝不干扰基准报告或门禁主链路。
- **配置面**：`autoCase`（zod，默认 true）——capture 量低（基准运行与无同意门禁都不频繁），默认开。
- id 唯一性：标题毫秒时间戳在前（sanitizeId 截 40 字符，时间戳必须活过截断），同毫秒双 capture 由调用方的 containment 兜底。

## Alternatives considered

- **自动给 capture 写真 rubric**：rubric 是评估契约（A5 的 Capability Contract/casecheck 管线管的就是它质量），机械生成必然是坏 contract——宁要诚实的"未校准"脚手架，不要貌似可评的假 case。
- **进用户 benchmark 的 draft 档**：run 不过滤 status，脚手架会进评估；改 run 过滤 draft 会翻转存量语义（所有默认 draft 的老 case 瞬间退出评估），影响面远超本功能。
- **LLM 起草 statement/rubric**：失败时刻多一次 LLM 调用，且把"发生了什么"变成"模型认为发生了什么"；statement 的价值恰在机械可证（reasons 逐字来自决策）。
- **门禁 `!shouldRefine` 也 capture**：那是"判断不需要进化"，不是失败——capture 会把噪声灌满容器。

## Consequences

- 失败进化从「审计记录」升级为「回归脚手架」：下次有人动 benchmark 循环时，`auto_regression` 容器就是待校准的失败清单，同时天然是 D2 继承度量的数据源。
- 容器 benchmark 会随时间积累——人工迁移/清理是设计内动作；清理目前走手工删除 `evolve/benchmarks/auto_regression/` 目录（`removeBenchmark` 死函数已于 2026-08-28 审计轮删除，命令面按真实需求再议）。
- draft case 不参与真实评估的边界靠容器隔离而非 status 过滤，run 语义未动（A5 的 status 过滤留待后续定案）。

## Testing

- `test/autocase.test.ts`（6 例）：容器首次自动创建 + 每次 capture 一个 draft（A5 meta status）、失败轨迹逐字段进 statement、毫秒戳在 40 字符 id 截断下唯一、无 session/refinement 的字段省略、rubric 载明捕获信号与不可评性。

## Related

- [pi/dsh 生态竞品差距分析](../../../../docs/research/pi-dsh-competitor-gap-analysis.md)：§5.2 P1-3，证据源（dsh-auto-evolve 沙箱回放、ouroboros 分阶段评估）。
- A5 case 生命周期（draft→calibrating→frozen）：capture 落在 draft 档，迁移走人工校准管线。
- [write-time-conflict-guard](2026-08-24-write-time-conflict-guard.md)：同为「失败信号 → 后续循环输入」的管线思想。
