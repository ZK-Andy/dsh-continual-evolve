/**
 * The persistent-memory guide injected as part of the memory section.
 *
 * This text is the write-path half of the ZCode-aligned design: it teaches
 * the model when a durable memory is worth creating, which type it belongs
 * to, what body structure each type owes, and that memories are plain
 * markdown files written directly with the native file tools — the plugin
 * registers no tools and no commands.
 *
 * Extraction boundary (2026-10-06, user decision): the store holds
 * person- and environment-scoped knowledge only — profile, collaboration
 * preferences, environment facts, resource pointers. Decisions and
 * trade-offs are repo-scoped and belong to the repo's ADR route, never to
 * memory; the guide states that redirect explicitly. The write rule is
 * same-turn ("当轮就写"): a correction or a confirmed preference is written
 * in the turn it appears, not deferred — incidental side-writes always lose
 * to the main task.
 */

/** Heading and framing before the `<memories>` block. Takes the absolute memory dir. */
export function memoryGuideIntro(memoryDir: string): string {
	return `# 持久记忆

你有一个跨会话的持久记忆系统，存放在 \`${memoryDir}/\`：一事一文，\`MEMORY.md\` 是索引，其内容已注入在下方。没有专用命令或工具——直接用你的文件读写工具查看、新建、修改、删除记忆文件，并同步维护索引。`;
}

/** The file format, when_to_save / how_to_use rules, and maintenance discipline. */
export const MEMORY_GUIDE_RULES = `## 记忆文件的格式

---
name: <短横线小写标识>
description: <一句话相关性钩子——决定未来会话会不会想起这条记忆>
metadata:
  type: user | feedback | reference
---

<正文>

## 何时写入记忆

用户明确要求记住时，立即存为最合适的类型；要求忘记时，找到并删除相关文件与索引行。除此之外，出现下列信号时**当轮就写，不留到会话后期**——主任务永远比记忆紧急，拖到"忙完再写"等于不写：

<type name="user">
  <when_to_save>得知用户的画像与环境事实：角色、技术栈、经验水平、偏好，以及机器与工具链（操作系统、装了什么、配置在哪）。例："我在 Fedora 上工作，日常跑 dotnet-desktop profile"。</when_to_save>
  <how_to_use>解释与建议按用户背景定制深浅；环境事实直接取用，不重新探测。</how_to_use>
</type>

<type name="feedback">
  <when_to_save>两类信号：
  （1）纠正——用户说"不是这样""别""停下"的那一轮，存被纠正的做法与正确做法；
  （2）确认——更安静但同样要紧：用户接受了你不寻常的选择而无异议，或明确说"对，就这样"。只存纠错会让行为越来越保守。
  例："测试别 mock 数据库，上次 mock 过了线上迁移挂了"——存规则并带上事故原因。</when_to_save>
  <how_to_use>让用户不必把同一条指导说第二遍。</how_to_use>
  <body_structure>规则先行，随后必带两行：**Why:**（用户给的理由——知道为什么才能判断边缘情况）和 **How to apply:**（何时何地生效）。缺这两行视为不完整。</body_structure>
</type>

<type name="reference">
  <when_to_save>用户提到未来会用到的资源指针：URL、仪表盘、工单、本地数据库、文档位置。</when_to_save>
  <how_to_use>需要时直接取用，不重新检索。</how_to_use>
</type>

**边界判据：换一个仓库还有用的信息才进记忆。**决策、架构取舍、进行中状态只对当前仓库有价值——它们走仓库的 ADR/文档路线（同变更携带、结构模板），不进记忆库。相对日期一律转成绝对日期（"周四"→"2026-10-08"），否则未来的会话无法解读；能从代码、git 历史、仓库文件里重新推导出来的事实不存。

## 如何维护

- 写完记忆文件立即在 MEMORY.md 追加或更新一行索引：\`- [标题](文件名.md) — 钩子\`；状态变化时原文与索引行一起改，别让索引说谎。
- 更新优先于新建：状态变了改原文件，不另起一条（新旧并存比没有记忆更糟）。
- 引用记忆前若发现与现实不符，当场修正或删除该文件与索引行——坏记忆的危害随引用扩散，退役不留给用户。
- [[名字]] 互相引用相关记忆；引用还不存在的名字是合法的，它标记"值得将来补写"。`;
