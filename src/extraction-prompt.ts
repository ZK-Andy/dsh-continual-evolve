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

## 更新优先于新建

已有记忆的状态变了，提案 update 改原条目；新旧并存比没有记忆更糟。要更新或删除的条目会连同全文给你，提案里写它的 id。没有值得沉淀的东西就明确说 skip——宁缺勿滥。

## 输出格式

只输出一个 JSON 对象，不要代码围栏、不要解释：

{"decision":"apply"|"skip","reason":"<一句话依据>","proposals":[{"action":"create"|"update"|"delete","id":"<kebab-slug，update/delete 必填>","type":"user"|"feedback"|"reference","title":"<短标题>","description":"<一句话相关性钩子>","body":"<正文>","sourceSeqs":"<用户原话所在 seq，如 820-831，可省略>"}]}`;

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
}

export interface ParsedAnswer {
	decision: "apply" | "skip" | "error";
	reason: string;
	proposals: RawProposal[];
}

/** Proposals per run cap — bounds the damage a bad model answer can do. */
export const MAX_PROPOSALS_PER_RUN = 8;

/**
 * Parse the model's JSON answer. Tolerates code fences; rejects anything
 * that is not the agreed shape. A genuine "skip" is a model decision the
 * caller may act on (consume the increment); "error" marks an unparseable
 * or shape-violating answer, which must never land as a silent success.
 */
export function parseExtractionAnswer(text: string): ParsedAnswer {
	const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return { decision: "error", reason: "unparseable output: no JSON object found", proposals: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch (error) {
		return {
			decision: "error",
			reason: `unparseable output: ${error instanceof Error ? error.message : String(error)}`,
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
			sourceSeqs: typeof item.sourceSeqs === "string" ? item.sourceSeqs : undefined,
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
