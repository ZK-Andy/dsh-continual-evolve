/**
 * The persistent-memory guide injected as part of the memory section —
 * three sentences of discipline, nothing more (the v0.15 SQLite single-store
 * redesign, ADR `2026-10-06-sqlite-single-store`).
 *
 * The store is a central database only the plugin's code can write; the
 * model reads the injected index, fetches bodies with `evolve_read`
 * (kind=memory), and lands explicit writes through `evolve_write`
 * (kind=memory). Automatic sedimentation is
 * the extraction pipeline's job and the main session must not spend tokens
 * maintaining memory. The write-quality taxonomy (what deserves a memory,
 * type bodies, the ADR boundary) moved to the extraction prompt, which is
 * the only writer left that needs it.
 */

/**
 * Heading and framing before the `<memories>` block. `toolsAvailable`
 * reflects whether the tool registration actually succeeded on this host:
 * a host without the tools service degrades to "tell the user" phrasing
 * instead of naming tools that do not exist.
 */
export function memoryGuideIntro(storePath: string, workspaceId: string, toolsAvailable: boolean): string {
	if (toolsAvailable) {
		return `# 持久记忆

持久记忆存放在中央库 \`${storePath}\`（按工作区分区，当前工作区：\`${workspaceId}\`）。下方索引只有钩子（id、标题、截断的描述，按 User Profile / Project Meta / Project Memory / Feedback Memory 四组排列），不含正文；要正文或按关键词检索，用 \`evolve_read\`（kind=memory）。

用户明确要求记住时用 \`evolve_write\`（kind=memory，action: create；feedback 正文必带 **Why:** 与 **How to apply:**），忘掉用 delete，情况变用 update。其余沉淀归会话结束后的专职提取流程，执行任务途中不要维护记忆。`;
	}
	return `# 持久记忆

持久记忆存放在中央库 \`${storePath}\`（当前工作区：\`${workspaceId}\`），但本宿主未挂载记忆读写工具。下方索引只有钩子（id、标题、截断的描述）；需要正文时，把 id 告诉用户请其代查。

用户要求记住或忘记时，把内容和类型（user/feedback/reference）告诉用户，由用户手动管理。其余沉淀归会话结束后的专职提取流程。`;
}

/**
 * Hard rules that ride along regardless of the intro (kept as a separate
 * constant so the section renderer can compose them once).
 */
export const MEMORY_GUIDE_RULES = `**边界：换一个仓库还有用的信息才进记忆。**决策、架构取舍、进行中状态走仓库的 ADR/文档路线，不进记忆库；相对日期一律写成绝对日期（"周四"→"2026-10-08"）。`;
