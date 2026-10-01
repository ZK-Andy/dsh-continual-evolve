# dsh-continual-evolve v2 方案：被动读路径 + 低摩擦写路径

> 状态：**已实施**（2026-10-01）。决策、实测数据与取舍见 ADR
> `.agents/notes/implemented/feature/2026-10-01-evolve-v2-passive-read-write.md`。
> 对照物：ZCode 的持久记忆系统（用户认可其体感，v2 的对标物）。
> 核验基准：2026-09-08 的上游（DSH）克隆；实施时以 `packages/core/system-prompt/src/index.ts` 的 `section()` 实际签名为准。

前置机制细节：查上游 `SECTION_ORDERS` 的完整槽位表，确定记忆索引该插在哪个位置、以及怎么做才能不打断 prompt cache。

存储层不动（那部分已做得比 ZCode 还重，保留）。改动集中在两条路径，都在本插件仓库做。

---

## 改动一：会话开场注入记忆索引（读路径）

**机制**：用上游现成的 `ctx.systemPrompt.section()` 注册一个 section：

```ts
ctx.systemPrompt.section({
  name: 'evolve:memory-index',        // 全局唯一，不会触发重名 fail-loud
  order: 400,                          // PERSONA(0) 之后、PLAN_POLICY(500) 之前
  text: buildMemorySection(),          // 会话启动时算一次
})
```

位置选 400 的理由：记忆是「用户是谁、怎么协作」级别的信息，应排在行为策略（PLAN/TEAM/工具指导）之前；顺序表里 0–500 之间是空槽，不挤占上游命名槽位。

**三条硬规则**：

1. **会话启动时算一次，会话中途不刷新**。索引变了就等下个会话生效——这样 system prompt 整场逐字节稳定，prompt cache 不破（现在 cacheWrite=0、cacheRead 命中的健康状态必须保住）。中途写入的即时可见性用 `evolve_recall` 兜底。
2. **注入的是记忆内容不是文件路径**。记忆库在 `~/.dsh/evolve/`，在 workspace sandbox 之外，模型用 read 工具读不到——所以别学 ZCode 给路径让它自己读，直接把每条事实的完整文本（一条通常 100–300 tok）灌进 section。
3. **预算 + 降级**：总量上限 ~6k 字符。超限时按 project > feedback > user > reference 排序保留全文，其余降级为一行索引（title + description hook），并附一句「更多记忆可用 evolve_recall 按需读取」。照抄 ZCode 的哲学：**预算是硬的，宁可 names-only 也不无限长**。

---

## 改动二（重点）：when_to_save 指南全文

这段是注入 section 的一部分，也是系统好不好用的隐藏主力——ZCode 好用一半功劳在这段 prompt 上。以下是可直接落进插件的中文全文（要留英文版就照 ZCode 原文对照翻）：

```markdown
# 持久记忆

你有一个跨会话的持久记忆系统。以下是当前记忆（已直接注入，无需查询即可使用；
需要检索完整内容或确认是否有相关记忆时，调用 evolve_recall）。

<memories>
（索引/全文，见改动一）
</memories>

## 何时写入记忆

用户明确要求记住时，立即存为最合适的类型；要求忘记时，找到并删除相关条目。
除此之外，在对话中自然遇到以下信号时主动写入。存之前先过一道筛子：
**能从代码、git 历史、仓库文件里重新推导出来的事实不存**——只存重推导不出来的
背景、决策和偏好。相对日期一律转成绝对日期（"周四"→"2026-10-08"），否则未来
的会话无法解读。一条事实一个条目；不确定值不值得存时，问自己"这条的信息量
是否在'为什么'里，而不在'是什么'里"。

<type name="user">
  <when_to_save>得知用户的角色、技术栈、经验水平、偏好或知识背景的任何细节时。
  例如用户自述"我是数据科学家，在查日志系统"——存：用户是数据科学家，
  当前关注可观测性/日志。</when_to_save>
  <how_to_use>后续解释和建议按用户的背景定制深浅与类比；对资深工程师
  不解释基础概念，对某领域的新手用其熟悉领域的类比切入。</how_to_use>
</type>

<type name="feedback">
  <when_to_save>两条信号，缺一不可：
  （1）纠正——用户说"不是这样""别""停下"时，存被纠正的做法与正确做法；
  （2）确认——这是更安静、更容易漏的信号：用户接受了你不寻常的选择而没有异议，
  或明确说"对，就这样""保持这样"。确认过的判断是已验证的方法论，只存纠错
  会让你的行为越来越保守、偏离用户已认可的路。
  例："测试别 mock 数据库，上次 mock 过了线上迁移挂了"——存规则并带上事故原因。
  例："结尾不用总结，diff 我自己会看"——存：该用户不要尾随性总结。</when_to_save>
  <how_to_use>让用户不必把同一条指导说第二遍。</how_to_use>
  <body_structure>规则先行，随后必带两行：**Why:**（用户给的理由，常是某次
  事故或强偏好——知道为什么才能判断边缘情况该不该破例）和 **How to apply:**
  （何时何地生效）。feedback 类型缺这两行视为不完整。</body_structure>
</type>

<type name="project">
  <when_to_save>得知进行中的工作、目标、决策、截止期或事故的背景动机时——
  凡是"谁在做什么、为什么、到什么时候"且无法从代码或 git 推导的信息。
  这类记忆衰减快，状态变化时更新它，别堆叠新条目。</when_to_save>
  <how_to_use>用它补全请求背后的上下文与动机，让建议贴住真实约束。
  例："周四起冻结合并"——存：2026-03-05 起冻结合并，非关键 PR 提前标记。</how_to_use>
  <body_structure>事实/决策先行 + **Why:**（动机：约束、deadline、干系人要求）
  + **How to apply:**（这条如何影响后续建议）。</body_structure>
</type>

<type name="reference">
  <when_to_save>用户提到未来会用到的外部资源指针：URL、仪表盘、工单、
  文档位置。</when_to_save>
  <how_to_use>需要时直接取用，不重新检索。</how_to_use>
</type>

## 如何维护

- 更新优先于新建：状态变了改原条目，不另起一条（新旧并存比没有记忆更糟）。
- 每条的 description 是给未来会话的相关性 hook——写"决定了一条记忆会不会
  被想起"的一句话，不写流水账。
- [[名字]] 互相引用相关记忆；引用还不存在的名字是合法的，它标记"值得将来补写"。
```

注意两处最容易抄丢的细节已显式化：**确认信号比纠错更安静、要主动盯**（只存纠错会让 agent 越来越保守），和 **description 就是未来的相关性 hook**（这直接决定改动一的索引质量）。

---

## 改动三：写路径降摩擦

- 主会话直写（`evolve_add`）在注入的 section 里**点名授权**（指南已隐含，可再加一句「主会话内直接用 evolve_add 落盘，无需等待后台流程」）。
- 后台 memory agent / review / benchmark 流水线降级为可选（config 开关，默认 off 或仅 idle 时跑）。token-usage.jsonl 里 9-24 有连续 error 记录——流水线出问题时至少主路径还能用。
- 顺手瘦身 6 个工具的 description（`evolve_add` 一个就 1.8k 字符）——注入 section 大约 +1.5~2.5k tokens/请求，把工具 schema 砍一半正好对冲，净增接近零。

## 验收

1. 快照测试：首请求 system 里包含 evolve:memory-index section，且两次请求逐字节一致（守 cache）。
2. 实测：改后跑一个会话，查 projcache 的 `contextBreakdown.systemTokens` 与 `cacheWrite`（应仍为 0）。
3. A/B 体感：同一任务 ZCode vs 新版 evolve，看「该记住的东西第二个会话是否自动生效」——这是唯一在意的验收标准。

## 实施备注

- 改动量估计：改动一约百行级（section 注册 + 预算降级逻辑），改动二纯文本，改动三主要是删减和开关。
- 本仓已有注入机制对照：`inject.ts` + `source.ts`（`2d8897a`）当前用 **order 119** 的动态 section——实施前需先查上游 `SECTION_ORDERS` 确认 119 与 400 的共存/冲突关系，避免两套注入打架。
- 非平凡变更须同变更携带 ADR（仓库纪律）；涉及插件行为改动 → 构建 + 用户重启验证（先确认 profile 是软链还是 npm 实体拷贝）。
