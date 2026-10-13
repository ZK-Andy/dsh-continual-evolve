# Agent Note: feedback 提示语被回抄进改写正文

Status: proposed

## Problem

试运行观察（2026-10-14）拿到 `review_log` 里第一条带 `proposed` 的 rewrite（条目 `codegraph`），发现昂贵门产出的改写正文末尾多出一句**不是记忆内容**的元指令：

> 注意：feedback 类正文必须带 Why 与 How to apply 两行。

来源在 [review.ts](../../../../src/review.ts) 的 `reviewOne`：它给 feedback 类候选构造 `extra`，由 [review-prompt.ts](../../../../src/review-prompt.ts) 的 `evolvePrompt` 追加在**待改写全文之后**。模型把这行提示当成正文的一部分照抄了回来。dry-run 下它只躺在账本里；**一旦关掉 dry-run，这句元指令会真的落进记忆正文**。

## Proposal

- 删掉 `evolvePrompt` 的 `extra` 参数与 `reviewOne` 的构造点：`REVIEW_MEMORY_SYSTEM_PROMPT` 已经写着「反馈类必须带 Why 与 How to apply」，该提示在 user prompt 里是冗余的——而冗余提示出现在「待改写全文」的紧邻位置，正是被回抄的原因。
- 回归测试：
  - `test/review-prompt.test.ts` 现有两条 `extra` 断言（`extra: ""` 不出现、`extra: "判时注意时效"` 出现）随参数删除一并改写；
  - `test/review.test.ts` 新增一条：用记录 prompt 的 fake LLM 跑一次 feedback 候选，断言送进昂贵门的 prompt **不含**「注意：feedback 类正文必须带 Why 与 How to apply 两行」；
  - 补一条正向断言：feedback 的改写落盘仍过 `fieldGateReasons`（正文缺 Why/How 时拒绝落盘）。
- 验证：`pnpm typecheck && pnpm lint && pnpm test` + 文档门禁全绿，**随下一批发版**，不单独发版。

## Alternatives considered

- **把提示挪到 system prompt**：system prompt 里已有同义要求（五维判据的「可用」一条），再加一遍是重复；两处措辞并存反而让"该听哪句"更模糊。
- **解析时从 `body` 里剥掉那一行**：治标——按字面剥只在提示语逐字不变时有效，模型换个说法（如「（本条目为 feedback 类）」）就漏；且把内容清洗塞进 `parseEvolveAnswer` 会让解析与清洗两种职责混在一起。
- **靠落盘门禁兜底**：feedback 的 Why/How 门禁会在落盘把关，但元指令**能过门禁**（它不违反任何机械规则），拦不住它。
- **什么都不做，等人审拟稿时剔除**：与"零人工"目标冲突；dry-run 关掉后错误内容已落盘，回滚成本更高。

## Consequences

- 昂贵门看到的待改写文本与记忆实际内容一致，不再有提示语混进拟稿。
- feedback 条目仍由 system prompt 与落盘门禁两层保证 Why/How 齐全——删掉的只是重复提示，不是约束。
- 已产生的 dry-run 账本行（含那一句）留在 `review_log` 作历史证据，不追溯修改。
