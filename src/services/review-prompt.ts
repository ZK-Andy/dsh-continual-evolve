/**
 * The content-quality review prompts (the model side of the autonomous
 * evolution loop): a cheap gate that decides whether an item deserves a
 * close look, and the evolve pass that judges content quality dimension by
 * dimension and proposes the rewrite. Code owns every consequence — the
 * model only returns verdict JSON, never touches the store.
 *
 * Memories are judged on five dimensions (accurate, usable, reusable,
 * non-duplicate, fresh); skills on four (description trigger precision,
 * body executability, reusability, non-duplicate). The prompts are
 * deliberately behavior-blind: there are no task datasets here (unlike
 * Hermes GEPA), only the item text plus its provenance.
 *
 * Each of the four review jobs has its own gate/evolve prompt pair, and the
 * memory and skill rubrics contradict each other on home-ownership by design
 * (a memory must survive having its repo name stripped; a project skill must
 * not). Sharing one prompt between them is what made the review ring judge
 * skills by the memory rubric.
 */

export const REVIEW_MEMORY_CHEAP_SYSTEM_PROMPT =
	"你是记忆库的内容评审门。先过归属三测：①主语是用户/环境还是某仓库的某版机制（版本号、阈值、开关名出现即后者）；②抹掉仓库名版本号机制名后句子还成立吗；③仓库事实住 ADR/docs，记忆只收跟人走的。归属不过直接判 false 并注明放错家。再判值不值得细看：有明确事实、做法、偏好或可复用规程就批；空话、纯过程记录、一次性的瞬时输出、当轮已可推导的一律拒。只输出 JSON：{\"worthReview\": true|false, \"reason\": \"一句话\"}。";

/**
 * The skill cheap gate: the memory gate's rubric inverted on home-ownership.
 * A skill bound to one repo's paths, gates and workflow cards is a *project
 * skill* — its home test is the project, not the world — so the gate that
 * fronted skills with the memory rubric rejected them for being exactly what
 * they are. Every judgment here is scope-relative, and the scope rides the
 * user prompt.
 */
export const REVIEW_SKILL_CHEAP_SYSTEM_PROMPT =
	"你是技能库的内容评审门。先看归属（prompt 里标了 scope）：绑定某仓库的路径/门禁/流程**不是**缺陷——住项目分区（scope=project）的技能本来就只在该项目内生效，禁用「跨项目不可复用」「抹掉仓库名不成立」当理由去拒它；只有「scope=global 却绑定某仓库」才算放错家，直接判 false 并注明。再判值不值得细看：description 让人在该用时想得起、正文步骤可执行、有可复用的规程就批；空话、一次性输出、纯过程记录、与既有技能重复的一律拒。只输出 JSON：{\"worthReview\": true|false, \"reason\": \"一句话\"}。";

/** Memory rubric: accurate, usable, reusable, non-duplicate, fresh, right-home. */
export const REVIEW_MEMORY_SYSTEM_PROMPT =
	"你是记忆库的内容评审。先过归属三测（主语是用户/环境还是某仓库的某版机制；抹掉仓库名版本号机制名后还成立吗；仓库事实住 ADR/docs）：归属不过直接 quarantine 并注明放错家。再按五维判：①准确（事实可信、无幻觉）；②可用（Why/How 具体、可执行，反馈类必须带 Why 与 How to apply）；③可复用（未来会话用得上）；④不重复（与候选旧条比，有重复就指出来）；⑤不过时（未被纠正链取代）。只输出 JSON：{\"verdict\": \"keep|rewrite|quarantine|archive|promote|demote|export-suggestion\", \"reason\": \"一句话\", \"title\"?: \"改写后标题\", \"description\"?: \"改写后钩子\", \"body\"?: \"改写后正文全文\", \"corrects\"?: \"被取代的同区条目id\"}。verdict 说明：keep=不动；rewrite=给出改写后全文三件；quarantine=涉密/有害/过时；archive=内容本身没错但压根不该长期存在（一次性的过程、当轮可推导的空话、早已被仓库文档覆盖）——它可逆、保留历史；promote=这条是**人物的画像/跨项目做法**（主语是我或环境、抹掉仓库名仍成立）且当前住在项目分区，值得成为全局记忆；export-suggestion=内容没错、但它的家是**仓库文档**（项目机制、命令、门禁这类读仓库文件就够的事）——只出建议不搬，也不隔离；demote=这条**绑定了某个仓库**（路径、门禁、版本、某项目状态）却住在全局分区，应退回项目分区；scope 字段给了你判据：scope=person 是候选、scope=global 的行才可能该 demote。禁删除，禁编造引用。";

/**
 * Skill rubric: trigger precision, executability, reuse, non-duplicate — with
 * the cross-project reuse test reserved for `scope=global`. A skill bound to
 * one repo's paths, gates and workflow cards is not defective when it lives in
 * that project's partition (that is what a project skill is for); only a
 * repo-bound skill sitting in the global partition is mis-homed.
 */
export const REVIEW_SKILL_SYSTEM_PROMPT =
	"你是技能库的内容评审。先看归属（prompt 里标了 scope）：绑定某仓库的路径/门禁/流程**不是**缺陷——住项目分区（scope=project）的技能本来就只在该项目内生效，禁用「跨项目不可复用」「抹掉仓库名不成立」当理由去改写或隔离它；只有「scope=global 却绑定某仓库」才算放错家，直接 quarantine。再判：①触发精度（description 是否让人/模型在该用时想起、不该用时不打扰）；②正文可执行完备（步骤完整、输入输出明确）；③可复用（scope=project 按该项目内跨任务可用判，scope=global 才按跨项目可用判）；④不重复（与候选既有技能比）。只输出 JSON：{\"verdict\": \"keep|rewrite|quarantine\", \"reason\": \"一句话\", \"title\"?: \"改写后标题\", \"description\"?: \"改写后钩子\", \"body\"?: \"改写后正文全文\"}。verdict 说明：keep=不动；rewrite=给出改写后全文三件；quarantine=涉密/有害/完全过时/放错家。禁删除。";

export interface GateVerdict {
	worthReview: boolean;
	reason: string;
}

/** The verdicts the memory rubric may return, including the tiering exits. */
export const MEMORY_VERDICTS = ["keep", "rewrite", "quarantine", "archive", "promote", "demote", "export-suggestion"] as const;
/** The verdicts the skill rubric may return (skills have no layers to move). */
export const SKILL_VERDICTS = ["keep", "rewrite", "quarantine"] as const;

export interface EvolveVerdict {
	verdict: "keep" | "rewrite" | "quarantine" | "archive" | "promote" | "demote" | "export-suggestion";
	reason: string;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	corrects?: string | undefined;
}

/** The cheap-gate prompt for one item (id + hook + body, truncated by caller). */
export function gatePrompt(entry: { kind: string; id: string; title: string; description: string; body: string; scope?: "project" | "global" | undefined }): string {
	const lines = [`kind=${entry.kind} id=${entry.id}`];
	if (entry.scope !== undefined) {
		lines.push(`scope=${entry.scope}`);
	}
	lines.push(`title=${entry.title}`, `钩子=${entry.description}`, "全文：", entry.body);
	return lines.join("\n");
}

/** The evolve prompt for one item plus its similar neighbors for dup-checking. */
export function evolvePrompt(
	entry: { id: string; title: string; description: string; body: string; scope?: "project" | "global" | undefined },
	neighbors: readonly { id: string; title: string; description: string }[],
): string {
	const lines = [`id=${entry.id}`];
	if (entry.scope !== undefined) {
		lines.push(`scope=${entry.scope}`);
	}
	// Nothing rides after `全文：` — a rubric reminder adjacent to the item
	// text gets copied back as if it were content (2026-10-14, memory
	// `codegraph`). The rubric lives in the system prompt only.
	lines.push(`title=${entry.title}`, `钩子=${entry.description}`, "全文：", entry.body);
	if (neighbors.length > 0) {
		lines.push("", "同类候选（判重复用）：");
		for (const neighbor of neighbors) {
			lines.push(`- id=${neighbor.id} title=${neighbor.title} 钩子=${neighbor.description}`);
		}
	}
	return lines.join("\n");
}

/** Parse the cheap-gate answer; `null` when the model did not return verdict JSON. */
export function parseGateAnswer(text: string): GateVerdict | null {
	const parsed = parseJsonObject(text);
	if (parsed === null || typeof parsed.worthReview !== "boolean") {
		return null;
	}
	return {
		worthReview: parsed.worthReview,
		reason: typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason.slice(0, 300) : "无理由",
	};
}

/** Parse the evolve answer; `null` when the model did not return verdict JSON. */
export function parseEvolveAnswer(text: string): EvolveVerdict | null {
	const parsed = parseJsonObject(text);
	const known = [...MEMORY_VERDICTS] as readonly unknown[];
	if (parsed === null || !known.includes(parsed.verdict)) {
		// Skills never see the tiering exits in their rubric; the landing link
		// refuses them per item rather than dropping a whole answer here.
		return null;
	}
	const verdict: EvolveVerdict = {
		verdict: parsed.verdict as EvolveVerdict["verdict"],
		reason: typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason.slice(0, 300) : "无理由",
	};
	if (typeof parsed.title === "string" && parsed.title.length > 0) {
		verdict.title = parsed.title.slice(0, 500);
	}
	if (typeof parsed.description === "string" && parsed.description.length > 0) {
		verdict.description = parsed.description.slice(0, 1000);
	}
	if (typeof parsed.body === "string" && parsed.body.length > 0) {
		verdict.body = parsed.body.slice(0, 65536);
	}
	if (typeof parsed.corrects === "string" && parsed.corrects.length > 0) {
		verdict.corrects = parsed.corrects.slice(0, 200);
	}
	return verdict;
}

/** Extract the first JSON object from model output (fenced or bare). */
function parseJsonObject(text: string): Record<string, unknown> | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = (fenced?.[1] ?? text).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
		/* v8 ignore next 3 — the slice always starts with `{`, so a
		successful parse is an object by construction; the guard stays. */
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
