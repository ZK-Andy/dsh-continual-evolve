/**
 * The persistent-memory guide injected as part of the memory section —
 * three sentences of discipline, nothing more (the v0.15 SQLite single-store
 * redesign, ADR `2026-10-06-sqlite-single-store`).
 *
 * The store is a central database only the plugin's code can write; the
 * model reads the injected index, fetches bodies with `memory_read`, and
 * lands explicit writes through `memory_write`. Automatic sedimentation is
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

你的持久记忆存放在中央库 \`${storePath}\`（按工作区分区，当前工作区：\`${workspaceId}\`）。下方注入的是本工作区的记忆索引（feedback > user > reference，只有钩子不含正文）；需要某条正文或想按关键词检索，用 \`memory_read\`。

用户明确要求记住时，用 \`memory_write\`（action: create）落库——feedback 类的正文必带 **Why:** 与 **How to apply:** 两行；要求忘记时用 action: delete；情况变了用 action: update 改原条目，不另起新条目。

除此之外的沉淀由会话结束后的专职提取流程负责——不要在执行任务途中分心维护记忆。`;
	}
	return `# 持久记忆

你的持久记忆存放在中央库 \`${storePath}\`（按工作区分区，当前工作区：\`${workspaceId}\`），但本宿主未挂载记忆读写工具。下方注入的是本工作区的记忆索引（feedback > user > reference，只有钩子不含正文）；需要正文时，把 id 告诉用户请其代查。

用户明确要求记住或忘记时，直接把要记的内容和类型（user/feedback/reference）告诉用户，由用户手动管理。

除此之外的沉淀由会话结束后的专职提取流程负责——不要在执行任务途中分心维护记忆。`;
}

/**
 * Hard rules that ride along regardless of the intro (kept as a separate
 * constant so the section renderer can compose them once).
 */
export const MEMORY_GUIDE_RULES = `**边界：换一个仓库还有用的信息才进记忆。**决策、架构取舍、进行中状态走仓库的 ADR/文档路线，不进记忆库；相对日期一律写成绝对日期（"周四"→"2026-10-08"）。`;
