/**
 * Backend user-visible copy for the four evolution confirmation dialogs,
 * in both shipped languages. Labels stay literal per language (the parsers
 * match them); guidance lives in `description`.
 *
 * Language is never hardcoded at a call site: every builder takes an
 * explicit `lang`, and dialog entry points resolve it per call
 * (explicit config upstream, else the durable DSH client preference,
 * else `en`) when the caller does not supply one.
 */
import { resolveRecordLanguage, type RecordLanguage } from "./record-language.js";

export interface ConfirmOption {
	label: string;
	description: string;
}

export interface ConfirmCopy {
	question: string;
	options: ConfirmOption[];
}

/** Maximum edit-summary chars carried into a dialog; longer text truncates. */
export const COPY_WHAT_MAX_CHARS = 300;

function compactWhat(what: string): string {
	return what.length > COPY_WHAT_MAX_CHARS ? `${what.slice(0, COPY_WHAT_MAX_CHARS)}…` : what;
}

/**
 * Persistent-scope write approval (`approve-global-evolve`).
 *
 * @param scope Target persistent scope.
 * @param what Edit summary shown in the dialog body.
 * @param lang Dialog language.
 */
export function approvalCopy(scope: "project" | "global", what: string, lang: RecordLanguage): ConfirmCopy {
	const body = compactWhat(what);
	if (lang === "zh") {
		const storeLabel = scope === "project" ? "本项目跨会话 store" : "跨会话全局 store";
		return {
			question: `写入${storeLabel}？\n${body}\n${scope === "project" ? "影响：仅本项目会话可见，可回滚。" : "影响：所有会话可见，可回滚。"}`,
			options: [
				{ label: "批准", description: scope === "project" ? "写入，仅本项目会话可见" : "写入，所有会话可见" },
				{ label: "拒绝", description: "不写入，本次跳过" },
			],
		};
	}
	const storeLabel = scope === "project" ? "project cross-session store" : "global cross-session store";
	return {
		question: `Write to the ${storeLabel}?\n${body}\n${scope === "project" ? "Impact: visible to this project's sessions only, reversible." : "Impact: visible to all sessions, reversible."}`,
		options: [
			{ label: "Approve", description: scope === "project" ? "Write, visible to this project only" : "Write, visible to all sessions" },
			{ label: "Decline", description: "Skip this write" },
		],
	};
}

export interface FateConsultSections {
	promotable: string[];
	splits: string[];
	reviewArchives: string[];
}

/**
 * Local-fate homing consult (`evolve-fate-consult`).
 *
 * @param sections Pre-rendered per-item lines per group.
 * @param lang Dialog language.
 */
export function fateConsultCopy(sections: FateConsultSections, lang: RecordLanguage): ConfirmCopy {
	if (lang === "zh") {
		const lines = ["自进化门禁：本会话 local 条目需要归宿处理"];
		if (sections.promotable.length > 0 || sections.splits.length > 0) {
			lines.push("【提升到全局（写入全局 store）】", ...sections.promotable, ...sections.splits);
		}
		if (sections.reviewArchives.length > 0) {
			lines.push("【归档（本地隐藏，可恢复）】", ...sections.reviewArchives);
		}
		lines.push("提升写入后所有会话可见，归档隐藏但可恢复。是否执行？");
		return {
			question: lines.join("\n"),
			options: [
				{ label: "执行", description: "提升写全局，归档隐藏本地（均可恢复）" },
				{ label: "不执行", description: "全部保留，10 回合内不再打扰" },
			],
		};
	}
	const lines = ["Evolution gate: this session's local entries need homing"];
	if (sections.promotable.length > 0 || sections.splits.length > 0) {
		lines.push("[Promote to global (write to the global store)]", ...sections.promotable, ...sections.splits);
	}
	if (sections.reviewArchives.length > 0) {
		lines.push("[Archive (hidden locally, restorable)]", ...sections.reviewArchives);
	}
	lines.push("Promotions become visible to all sessions; archives hide but stay restorable. Proceed?");
	return {
		question: lines.join("\n"),
		options: [
			{ label: "Proceed", description: "Promote to global, archive locally (all reversible)" },
			{ label: "Skip", description: "Keep everything, cooldown 10 turns" },
		],
	};
}

/**
 * Single-entry wrap-up archive confirm (`evolve-wrapup-archive-review`).
 *
 * @param title Entry title shown in the headline.
 * @param lang Dialog language.
 */
export function wrapupArchiveCopy(title: string, lang: RecordLanguage): ConfirmCopy {
	if (lang === "zh") {
		return {
			question: `wrapup 确认归档：条目「${title}」\n未被全局覆盖且源自真实对话。归档后不再注入，数据保留、可恢复。`,
			options: [
				{ label: "归档", description: "隐藏但可恢复" },
				{ label: "保留", description: "继续注入" },
			],
		};
	}
	return {
		question: `Wrap-up archive confirm: entry "${title}"\nNot covered globally and distilled from real conversation. Archiving stops injection; data stays restorable.`,
		options: [
			{ label: "Archive", description: "Hide but restorable" },
			{ label: "Keep", description: "Keep injecting" },
		],
	};
}

/**
 * Skill solidification consult (`evolve-skill-consult`).
 *
 * @param description Pre-rendered per-edit lines.
 * @param lang Dialog language.
 */
export function skillConsultCopy(description: string, lang: RecordLanguage): ConfirmCopy {
	if (lang === "zh") {
		return {
			question: `发现可复用的流程，建议固化为技能\n${description}\n\n固化后以后同类任务自动复用，可回滚。是否固化？`,
			options: [
				{ label: "固化", description: "生成技能，以后复用" },
				{ label: "不固化", description: "本次跳过，10 回合内不再打扰" },
			],
		};
	}
	return {
		question: `Reusable workflow found, suggest solidifying as a skill\n${description}\n\nSolidified skills are reused by similar tasks later, reversible. Solidify?`,
		options: [
			{ label: "Solidify", description: "Create the skill for reuse" },
			{ label: "Skip", description: "Skip this time, cooldown 10 turns" },
		],
	};
}

/**
 * One skill-edit line inside the solidification consult.
 *
 * @param action Edit action (`create` etc.).
 * @param title Entry title or id fallback.
 * @param skillKind `guidance` skills are SKILL.md documents.
 * @param lang Dialog language.
 */
export function skillEditLine(action: string, title: string, skillKind: string | undefined, lang: RecordLanguage): string {
	if (lang === "zh") {
		const form = skillKind === "guidance" ? "guidance 技能（SKILL.md 文档）" : "可执行技能";
		return `- ${action}「${title}」(${form})`;
	}
	const form = skillKind === "guidance" ? "guidance skill (SKILL.md document)" : "executable skill";
	return `- ${action} "${title}" (${form})`;
}

/**
 * Resolve the dialog language for a call site that holds no explicit
 * choice: durable client preference first, `en` otherwise. (Dialogs carry
 * no trajectory text, so there is no detection tier here.)
 *
 * @param ctx Host context for the durable-preference read.
 * @returns The dialog language.
 */
export function resolveDialogLanguage(ctx: unknown): RecordLanguage {
	return resolveRecordLanguage({ ctx });
}
