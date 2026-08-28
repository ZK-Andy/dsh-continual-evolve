# Agent Note: entry-valence-feedback

Status: implemented

## Problem

条目生命周期只有"暴露计数"这一种中性信号（usage.json v2，记"多少会话见过它"）与 staleness 衰减（B2），**没有效价**——一条被用户纠正/被新证据推翻的记忆，与一条被反复验证的记忆，在注入排序、fate/wrapup 分类面前完全同权。矛盾条目会持续被注入、持续误导后续会话，只能等 30 天零使用衰减或人为 archive。2026-08-28 pi/dsh 生态竞品调研确认这是标准能力：pi-continuous-learning 用 confirmed/contradicted 置信度闭环（+0.05/−0.15/被动衰减），czs/dsh-evolve 用重复观察强化（见 `docs/research/pi-dsh-competitor-gap-analysis.md` §5.2 P1-1）。

## Decision

沿用「机械审计提议 → LLM 分类 → 代码落地」分层，效价信号走**同一条 wrapup/fate 分类管道**，四段接线：

- **分类协议**：`WrapupItem` 增加可选 `contradicted` 标志，`parseWrapupAssessment` 严格解析——只有显式 JSON 布尔 `true` 生效，字符串/"truthy" 一律忽略（与 verdict 崩塌到 keep 同款防御姿态）。assessor 系统提示词增加指引：轨迹或全局证据推翻条目内容时置 `contradicted: true` 并优先 archive。
- **候选面**：`WrapupCandidate` 增加 `negativeCount`（读条目 metadata 的 `valenceNegative` 计数器，非法值归零），候选清单里以 `(contradicted N× before)` 标记展示给 assessor。
- **落地盖章**：verdict=keep 且 contradicted 的条目，wrapup 命令以共享构造器 `valenceStampProposal` 发一笔 local update，把 `valenceNegative` 计数 +1（确定性动作，无需审批）。promote 不盖章（人工批准的全局副本即活真相）；archive 不盖章（归档本身已移出注入）。
- **注入降权**：`inject.ts rankEntries` 把正计数条目沉到同相关性/同新近度的干净条目之后（无查询路径在 recency 之前判、查询路径在 relevance 之后判——**效价永不覆盖查询相关性**）。这是 contradicted −0.15 的行为学等价物，不引入新的分数轴。

`VALENCE_NEGATIVE_KEY = "valenceNegative"` 进 types.ts 元数据键封闭集；promote 的 metadata 展开会让计数随条目升入全局 store，跨会话生效。

## Alternatives considered

- **confirmed/contradicted 双向计数（pi 式置信度）**：confirmed 无法机械判定——"这条记忆帮到了本会话"没有可靠代码信号，硬造一个只会喂进模型自评噪声；先做单向负信号，confirmed 留待真实使用出现可判定信号再议。
- **置信度分数轴（0..1 浮点，事件调分）**：引入第三套排序维度（relevance/recency/confidence），阈值生态要重新校准且不可解释；计数器 + 排序降权同样单调、可审计、零新轴。
- **fate 路径同步盖章**：fate 的 FatePlan 不含 keep 条目（keep 在 fate 里即无动作），且 keep 条目是 local、随会话消亡，fate 阶段盖章价值趋零——v1 只在 wrapup 落章，deferred 记录于 Consequences。
- **全局条目直接由门禁审校 valence**：门禁 review 面向"是否进化"而非"逐条体检"，给全局条目挂效价需要独立的审查协议，属新功能而非管道加档；留待 D1 Refiner 数据到位后设计。

## Consequences

- 矛盾条目获得完整闭环：标记 → 计数上涨 → 注入沉底 → 下次评估优先 archive；R3 巩固循环未来可直接消费 `valenceNegative` 作为归档信号。
- fate 路径的 keep+contradicted 条目不盖章（上述理由）；`valenceStampProposal` 是共享导出，fate 需要时可一行接入。
- assessor 可能滥用 contradicted 标记把不想处理的条目打成矛盾——与 verdict 滥用同风险，由既有审批/守卫面兜底，无需新防线。

## Testing

- `test/wrapup.test.ts`：metadata 计数读取（含非法值归零）、严格布尔解析（`true`/"yes"/缺省）、stamp 构造器（keep+contradicted 出提案、archive/无标志出 undefined、计数 +1 携带旧 metadata）。
- `test/wrapup-command.test.ts`：引擎级——keep+contradicted 落章后 `valenceNegative=1` 且条目未被归档；无标志时零盖章。
- `test/inject.test.ts`：无查询路径与查询路径的降权、效价不覆盖查询相关性。

## Related

- [pi/dsh 生态竞品差距分析](../../../../docs/research/pi-dsh-competitor-gap-analysis.md)：§5.2 P1-1，证据源（pi-continuous-learning 置信度闭环、czs/dsh-evolve 观察强化）。
- [write-time-conflict-guard](2026-08-24-write-time-conflict-guard.md)：conflictHint 与 valenceNegative 同为元数据键封闭集成员，消费方（R3 巩固）相邻。
