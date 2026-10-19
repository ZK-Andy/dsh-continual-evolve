/**
 * The extraction prompt: what deserves a memory, how each type reads, and
 * the closed proposal format the model must answer in.
 *
 * The taxonomy moved here verbatim-in-spirit from the main-session guide
 * (the 4a1e57d version) when the store became a gated database: the
 * extraction model is the only writer left that needs the write-quality
 * rules, so teaching them in the main session would be spent tokens twice.
 * The model proposes; the store's gates (constraints, secret screen, dedup,
 * feedback contract) decide — the proposal is never trusted on its own.
 */

/** The extraction model's system prompt (Chinese — memory content is Chinese-first). */
export const EXTRACTION_SYSTEM_PROMPT = `你是记忆提取专员。你的唯一任务：从会话轨迹增量里判断哪些信息值得存入用户的跨会话持久记忆，并提出结构化提案。你不执行任务、不回答用户、不解释推理。

## 何时写入记忆

<type name="user">
  <when_to_save>得知用户的画像与环境事实：角色、技术栈、经验水平、偏好，以及机器与工具链（操作系统、装了什么、配置在哪）。例："我在 Fedora 上工作，日常跑 dotnet-desktop profile"。</when_to_save>
</type>

<type name="feedback">
  <when_to_save>两类信号：
  （1）纠正——用户说"不是这样""别""停下"的那一轮，存被纠正的做法与正确做法；
  （2）确认——更安静但同样要紧：用户接受了你不寻常的选择而无异议，或明确说"对，就这样"。只存纠错会让行为越来越保守。
  例："测试别 mock 数据库，上次 mock 过了线上迁移挂了"——存规则并带上事故原因。</when_to_save>
  <body_structure>规则先行，随后必带两行：**Why:**（用户给的理由——知道为什么才能判断边缘情况）和 **How to apply:**（何时何地生效）。缺这两行的提案会被机械拒绝。</body_structure>
</type>

<type name="reference">
  <when_to_save>用户提到未来会用到的资源指针：URL、仪表盘、工单、本地数据库、文档位置。</when_to_save>
</type>

**边界判据：换一个仓库还有用的信息才进记忆。**决策、架构取舍、进行中状态只对当前仓库有价值——它们走仓库的 ADR/文档路线，绝不提案。能从代码、git 历史、仓库文件里重新推导出来的事实不存；临时任务状态、一次性调试过程、无复现证据的问题修复不存。相对日期一律转成绝对日期（"周四"→"2026-10-08"）。

**归属三测（任一不通过即不提案，与上面的边界判据是同一把尺子）：**
1. 主语测试——这条的主语是"我/环境"，还是"这个仓库的某版机制"？版本号、阈值、开关名一出现，主语就是仓库，不提案。
2. 去名测试——把仓库名、版本号、机制名全抹掉，句子还成立吗？不成立，不提案。
3. 归属测试——仓库事实（设计拍板、版本细节、任务状态）住 ADR/docs/交接；记忆只收跟人走的（协作偏好、环境事实、跨项目做法）。

**三测全过之后写 scope：** 提案里加 "scope":"person"——它标记「这条跟人走」，是全局记忆的候选，两个条件不满足就不要写：主语是用户或环境（不是仓库），且抹掉仓库名后句子仍成立。任一不满足、或你拿不准，省略 scope（等同 "project"）。scope 只是标记，不改变这条记忆住在哪个工作区；是否真进全局由后续复核决定。

**落点测试（三测之外的追加判据，不替代三测）：** 这条事实的家是哪个文件？用户本轮若已把它写进、或明确要把它写进仓库里的某个文件（"记到/写进/加到 <任意落点>"），那个文件就是它的家——判 skip，reason 里引用用户原话。落点叫什么名字、是已有文件还是新文件、位于哪一层目录，都不影响判定；只看"这句事实已落进仓库文件"这个动作。增量里的 tools-this-turn 行只给工具名不给路径，用来判断"本轮发生过文件写入"，不据此猜测落点是哪个文件。同一句话在记忆与仓库文件里各存一份即为违规——记忆是另一个家，不是备份。

**正文去会话细节：** 正文写跟人走的可复用事实，剥离本轮的事故叙述、临时状态与一次性过程（"刚才那轮报错是因为……"这类只对本轮有意义的上下文不进正文；feedback 的 Why 行要的是用户给的可复用理由，不是本轮事故经过）。

## 更新优先于新建

已有记忆的状态变了，提案 update 改原条目；新旧并存比没有记忆更糟。要更新或删除的条目会连同全文给你，提案里写它的 id。没有值得沉淀的东西就明确说 skip——宁缺勿滥。

## 输出格式

只输出一个 JSON 对象，不要代码围栏、不要解释：

{"decision":"apply"|"skip","reason":"<一句话依据>","proposals":[{"action":"create"|"update"|"delete","id":"<kebab-slug，update/delete 必填>","type":"user"|"feedback"|"reference","title":"<短标题>","description":"<一句话相关性钩子>","body":"<正文>","notWhen":"<可选：不适用的条件，一句话>","scope":"person"|"project"（三测全过写 person，否则省略）,"sourceSeqs":"<用户原话所在 seq，如 820-831，可省略>"}]}`;

/** The pre-gate system prompt: a small verdict before the expensive full call. */
export const EXTRACTION_CHEAP_SYSTEM_PROMPT = `你是记忆提取的预检门。只判这轮轨迹增量里有没有值得沉淀的跨会话记忆（用户画像与环境事实、可复用的做法纠正与确认、未来会用的资源指针），先过归属三测：主语是用户/环境还是本仓库的某版机制；抹掉仓库名版本号机制名后还成立吗；仓库事实住 ADR/docs。再过落点测试：这条事实已被写进、或本轮明确要写进仓库里的某个文件（任何名字都算，只看"已落进仓库"这个动作）→ 家在那个文件，直接判 false。归属或落点不过都判 false。只输出 JSON，不要代码围栏、不要解释：

{"worthExtracting":true|false,"reason":"<一句话依据>"}`;

/** Head length of the serialized increment the pre-gate reads (small by design). */
export const CHEAP_INCREMENT_MAX = 4000;

/** The pre-gate prompt: increment head only — no manifest, no candidates. */
export function cheapPrompt(input: { incrementHead: string; userSeqs: readonly number[] }): string {
	return [
		"（用户直接发言所在 seq：",
		`${input.userSeqs.length > 0 ? input.userSeqs.join(",") : "无"}）`,
		input.incrementHead,
		"按系统指令输出 JSON 判定。",
	].join("\n");
}

/** The pre-gate verdict; `null` when the model did not return verdict JSON. */
export interface CheapVerdict {
	worth: boolean;
	reason: string;
}

/** Parse the pre-gate answer. `null` means fail-open: run the full call. */
export function parseCheapAnswer(text: string): CheapVerdict | null {
	const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch {
		return null;
	}
	// Defensive: the sliced text always starts with "{", so a successful
	// JSON.parse here is always an object — same guard as parseExtractionAnswer.
	/* v8 ignore next 3 */
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const answer = parsed as { worthExtracting?: unknown; reason?: unknown };
	if (typeof answer.worthExtracting !== "boolean") {
		return null;
	}
	const reason = typeof answer.reason === "string" && answer.reason.length > 0 ? answer.reason : "无理由";
	return { worth: answer.worthExtracting, reason: reason.slice(0, 300) };
}

/** The existing-memory manifest line shown to the model. */
export function manifestLineOf(record: {
	id: string;
	type: string;
	title: string;
	description: string;
}): string {
	return `- id=${record.id}｜type=${record.type}｜title=${record.title}｜钩子=${record.description}`;
}

/** The user-prompt block for one extraction run. */
export function extractionPrompt(input: {
	increment: string;
	manifest: string[];
	candidates: string[];
	userSeqs: readonly number[];
}): string {
	const parts: string[] = [];
	parts.push(`<manifest>
本工作区现有记忆（提案 update/delete 时引用这里的 id；与增量相似度最高的候选全文附后）：
${input.manifest.length > 0 ? input.manifest.join("\n") : "（本工作区还没有记忆）"}
</manifest>`);
	if (input.candidates.length > 0) {
		parts.push(`<candidates>
${input.candidates.join("\n\n")}
</candidates>`);
	}
	parts.push(`<increment>
（用户直接发言所在 seq：${input.userSeqs.length > 0 ? input.userSeqs.join(",") : "无"}）
${input.increment}
</increment>`);
	parts.push("按系统指令输出 JSON 提案。");
	return parts.join("\n\n");
}

/** The parsed model answer before store gating. */
export interface RawProposal {
	action: "create" | "update" | "delete";
	id?: string | undefined;
	type?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	sourceSeqs?: string | undefined;
	/** The ownership marker the promotion funnel watches (`person` = candidate). */
	scope?: string | undefined;
	/** Optional caveat rendered with the hook; presentation only. */
	notWhen?: string | undefined;
}

export interface ParsedAnswer {
	decision: "apply" | "skip" | "error";
	reason: string;
	proposals: RawProposal[];
}

/** Proposals per run cap — bounds the damage a bad model answer can do. */
export const MAX_PROPOSALS_PER_RUN = 8;

/**
 * Raw ISO control characters JSON forbids (`U+0000`–`U+001F` except the
 * whitespace JSON itself allows) plus `DEL`. Models occasionally leak one
 * into an otherwise valid answer; stripping them and re-parsing saves the
 * whole batch. Kept in the prompt module (not the caller) so every parse
 * site — extraction and both subagent definitions — shares the tolerance.
 */
// eslint-disable-next-line no-control-regex -- intentional: the exact JSON-illegal raw set, retried once before failing
const BARE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Parse one JSON candidate, or return the thrown message. */
function tryParseJson(candidate: string): { parsed?: unknown; message?: string } {
	try {
		return { parsed: JSON.parse(candidate) };
	} catch (error) {
		return { message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Parse the model's JSON answer. Tolerates code fences and bare control
 * characters (one sanitized retry); rejects anything that is not the agreed
 * shape. A genuine "skip" is a model decision the caller may act on (consume
 * the increment); "error" marks an unparseable or shape-violating answer,
 * which must never land as a silent success.
 */
export function parseExtractionAnswer(text: string): ParsedAnswer {
	const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return { decision: "error", reason: "unparseable output: no JSON object found", proposals: [] };
	}
	const candidate = stripped.slice(start, end + 1);
	const first = tryParseJson(candidate);
	// P1: a single control character no longer drops the batch — strip the
	// JSON-illegal ones and retry once. Still failing keeps the old error
	// path (raw head ledgered, increment unconsumed, next trigger retries).
	const parsed = first.parsed ?? tryParseJson(candidate.replace(BARE_CONTROL_RE, "")).parsed;
	if (parsed === undefined) {
		return {
			decision: "error",
			reason: `unparseable output: ${first.message ?? "unknown parse error"}`,
			proposals: [],
		};
	}
	// Defensive: the sliced text always starts with "{", so a successful
	// JSON.parse here is always an object — the branch is unreachable today
	// but stays as a guard against future slicing changes.
	/* v8 ignore next 3 */
	if (typeof parsed !== "object" || parsed === null) {
		return { decision: "error", reason: "unparseable output: not an object", proposals: [] };
	}
	const answer = parsed as { decision?: unknown; reason?: unknown; proposals?: unknown };
	const reason = typeof answer.reason === "string" ? answer.reason : "";
	if (answer.decision === "skip") {
		return { decision: "skip", reason: reason || "model chose to skip", proposals: [] };
	}
	if (answer.decision !== "apply") {
		return { decision: "error", reason: `unknown decision ${String(answer.decision)}`, proposals: [] };
	}
	if (!Array.isArray(answer.proposals)) {
		return { decision: "error", reason: "apply without a proposals array", proposals: [] };
	}
	const proposals: RawProposal[] = [];
	for (const raw of answer.proposals) {
		if (typeof raw !== "object" || raw === null) {
			continue;
		}
		const item = raw as Record<string, unknown>;
		const action = item.action;
		if (action !== "create" && action !== "update" && action !== "delete") {
			continue;
		}
		proposals.push({
			action,
			id: typeof item.id === "string" ? item.id : undefined,
			type: typeof item.type === "string" ? item.type : undefined,
			title: typeof item.title === "string" ? item.title : undefined,
			description: typeof item.description === "string" ? item.description : undefined,
			body: typeof item.body === "string" ? item.body : undefined,
			notWhen: typeof item.notWhen === "string" ? item.notWhen : undefined,
			sourceSeqs: typeof item.sourceSeqs === "string" ? item.sourceSeqs : undefined,
			// Sanitized here, not at the gate: an invented scope (say "global")
			// would reject the whole batch, and one bad marker is no reason to
			// drop the rest of a good answer.
			scope: item.scope === "person" ? "person" : undefined,
		});
		if (proposals.length >= MAX_PROPOSALS_PER_RUN) {
			break;
		}
	}
	if (proposals.length === 0) {
		return { decision: "error", reason: reason || "apply carried no usable proposals", proposals: [] };
	}
	return { decision: "apply", reason, proposals };
}
