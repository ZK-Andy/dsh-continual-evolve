# Agent Note: feedback 提示语被回抄进改写正文

Status: implemented

## Problem

试运行观察（2026-10-14）拿到 `review_log` 里第一条带 `proposed` 的 rewrite（条目 `codegraph`），昂贵门产出的改写正文末尾多出一句**不是记忆内容**的元指令：

> 注意：feedback 类正文必须带 Why 与 How to apply 两行。

来源是 `reviewOne` 给 feedback 类候选构造的 `extra`，由 `evolvePrompt` 追加在**待改写全文之后**——提示语紧邻正文，模型把它当成正文的一部分照抄了回来。dry-run 下它只躺在账本里；关掉 dry-run 后这句元指令会真的落进记忆正文。

## Decision

`evolvePrompt` 只承载条目本身（id / scope / title / 钩子 / 全文，加同类候选），行尾不再附加任何评审提示；`reviewOne` 不再为 feedback 构造 `extra`。feedback 的 Why/How 契约仍由两处已有机制承担：`REVIEW_MEMORY_SYSTEM_PROMPT` 的五维判据（system 侧，与正文不邻接），以及落盘时的 `fieldGateReasons`。

回归测试两条：送进昂贵门的 prompt 不含该提示语（用记录 prompt 的 fake LLM 断言 user 侧正文）；feedback 改写删掉 `Why:` 行时落盘门拒绝、库内正文保持不变。

## Alternatives considered

- **把提示挪到 system prompt**：system prompt 里已有同义要求（五维判据的「可用」一条），再加一遍是重复；两处措辞并存反而让"该听哪句"更模糊。
- **解析时从 `body` 里剥掉那一行**：治标——按字面剥只在提示语逐字不变时有效，模型换个说法（如「（本条目为 feedback 类）」）就漏；且把内容清洗塞进 `parseEvolveAnswer` 会让解析与清洗两种职责混在一起。
- **靠落盘门禁兜底**：feedback 的 Why/How 门禁会在落盘把关，但元指令**能过门禁**（它不违反任何机械规则），拦不住它。
- **什么都不做，等人审拟稿时剔除**：与"零人工"目标冲突；dry-run 关掉后错误内容已落盘，回滚成本更高。

## Consequences

- 昂贵门看到的待改写文本与记忆实际内容一致，不再有提示语混进拟稿。
- feedback 条目仍由 system prompt 与落盘门禁两层保证 Why/How 齐全——删掉的只是重复提示，不是约束。
- 已产生的 dry-run 账本行（含那一句）留在 `review_log` 作历史证据，不追溯修改。
- 随下一批发版生效，不单独发版。
