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
 */

export const REVIEW_CHEAP_SYSTEM_PROMPT =
	"你是记忆库的内容评审门。先过归属三测：①主语是用户/环境还是某仓库的某版机制（版本号、阈值、开关名出现即后者）；②抹掉仓库名版本号机制名后句子还成立吗；③仓库事实住 ADR/docs，记忆只收跟人走的。归属不过直接判 false 并注明放错家。再判值不值得细看：有明确事实、做法、偏好或可复用规程就批；空话、纯过程记录、一次性的瞬时输出、当轮已可推导的一律拒。只输出 JSON：{\"worthReview\": true|false, \"reason\": \"一句话\"}。";

/** Memory rubric: accurate, usable, reusable, non-duplicate, fresh, right-home. */
export const REVIEW_MEMORY_SYSTEM_PROMPT =
	"你是记忆库的内容评审。先过归属三测（主语是用户/环境还是某仓库的某版机制；抹掉仓库名版本号机制名后还成立吗；仓库事实住 ADR/docs）：归属不过直接 quarantine 并注明放错家。再按五维判：①准确（事实可信、无幻觉）；②可用（Why/How 具体、可执行，反馈类必须带 Why 与 How to apply）；③可复用（未来会话用得上）；④不重复（与候选旧条比，有重复就指出来）；⑤不过时（未被纠正链取代）。只输出 JSON：{\"verdict\": \"keep|rewrite|quarantine\", \"reason\": \"一句话\", \"title\"?: \"改写后标题\", \"description\"?: \"改写后钩子\", \"body\"?: \"改写后正文全文\", \"corrects\"?: \"被取代的同区条目id\"}。verdict 说明：keep=不动；rewrite=给出改写后全文三件；quarantine=涉密/有害/完全过时/放错家。禁删除，禁编造引用。";

/** Skill rubric: trigger precision, executability, reusability, non-duplicate, right-home. */
export const REVIEW_SKILL_SYSTEM_PROMPT =
	"你是技能库的内容评审。先过归属三测（技能是否绑定单一仓库的路径与机制；抹掉仓库名后还成立吗）：放错家直接 quarantine。再按四维判：①触发精度（description 是否让人/模型在该用时想起、不该用时不打扰）；②正文可执行完备（步骤完整、输入输出明确）；③可复用（跨任务可用）；④不重复（与候选既有技能比）。只输出 JSON：{\"verdict\": \"keep|rewrite|quarantine\", \"reason\": \"一句话\", \"title\"?: \"改写后标题\", \"description\"?: \"改写后钩子\", \"body\"?: \"改写后正文全文\"}。verdict 说明：keep=不动；rewrite=给出改写后全文三件；quarantine=涉密/有害/完全过时/放错家。禁删除。";

export interface GateVerdict {
	worthReview: boolean;
	reason: string;
}

export interface EvolveVerdict {
	verdict: "keep" | "rewrite" | "quarantine";
	reason: string;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	corrects?: string | undefined;
}

/** The cheap-gate prompt for one item (id + hook + body, truncated by caller). */
export function gatePrompt(entry: { kind: string; id: string; title: string; description: string; body: string }): string {
	return [
		`kind=${entry.kind} id=${entry.id}`,
		`title=${entry.title}`,
		`钩子=${entry.description}`,
		"全文：",
		entry.body,
	].join("\n");
}

/** The evolve prompt for one item plus its similar neighbors for dup-checking. */
export function evolvePrompt(
	entry: { id: string; title: string; description: string; body: string; extra?: string | undefined },
	neighbors: readonly { id: string; title: string; description: string }[],
): string {
	const lines = [
		`id=${entry.id}`,
		`title=${entry.title}`,
		`钩子=${entry.description}`,
		"全文：",
		entry.body,
	];
	if (entry.extra !== undefined && entry.extra.length > 0) {
		lines.push("", entry.extra);
	}
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
	if (parsed === null || (parsed.verdict !== "keep" && parsed.verdict !== "rewrite" && parsed.verdict !== "quarantine")) {
		return null;
	}
	const verdict: EvolveVerdict = {
		verdict: parsed.verdict,
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
