/**
 * The persistent-memory guide injected as part of the memory section.
 *
 * This text is the write-path half of the ZCode-aligned design: it teaches
 * the model when a durable memory is worth creating, which type it belongs
 * to, what body structure each type owes, and that memories are plain
 * markdown files written directly with the native file tools — the plugin
 * registers no tools and no commands.
 *
 * Provenance: the when_to_save taxonomy is adapted from ZCode's persistent-
 * memory prompt (introduced here in evolve v2); the write-path wording now
 * targets native file operations on `<workspace>/.evolve/memory/`.
 */

/** Heading and framing before the `<memories>` block. Takes the absolute memory dir. */
export function memoryGuideIntro(memoryDir: string): string {
	return `# 持久记忆

你有一个跨会话的持久记忆系统，存放在 \`${memoryDir}/\`：一事一文，\`MEMORY.md\` 是索引，其内容已注入在下方。没有专用命令或工具——直接用你的文件读写工具查看、新建、修改、删除记忆文件，并在同一会话内顺手落盘。`;
}

/** The file format, when_to_save / how_to_use rules, and maintenance discipline. */
export const MEMORY_GUIDE_RULES = `## 记忆文件的格式

---
name: <短横线小写标识>
description: <一句话相关性钩子——决定未来会话会不会想起这条记忆>
metadata:
  type: user | feedback | project | reference
---

<正文>

## 何时写入记忆

用户明确要求记住时，立即存为最合适的类型；要求忘记时，找到并删除相关文件与索引行。
除此之外，在对话中自然遇到以下信号时主动写入。存之前先过一道筛子：
**能从代码、git 历史、仓库文件里重新推导出来的事实不存**——只存重推导不出来的
背景、决策和偏好。相对日期一律转成绝对日期（"周四"→"2026-10-08"），否则未来
的会话无法解读。一条事实一个文件；不确定值不值得存时，问自己"这条的信息量
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
  这类记忆衰减快，状态变化时更新它，别堆叠新文件。</when_to_save>
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

- 写完记忆文件后立即在 MEMORY.md 追加或更新一行索引：\`- [标题](文件名.md) — 钩子\`；状态变化时原文与索引行一起改，别让索引说谎。
- 更新优先于新建：状态变了改原文件，不另起一条（新旧并存比没有记忆更糟）。
- 引用记忆前若发现与现实不符，当场修正或删除该文件与索引行——坏记忆的危害随引用扩散，
  退役不留给用户。
- [[名字]] 互相引用相关记忆；引用还不存在的名字是合法的，它标记"值得将来补写"。`;
