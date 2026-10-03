/**
 * Backend user-visible copy for the evolution confirmation dialogs, in both
 * shipped languages. Labels stay literal per language (the parsers match
 * them); guidance lives in `description`.
 *
 * Language is never hardcoded at a call site: every builder takes an
 * explicit `lang`, and dialog entry points resolve it per call
 * (explicit config upstream, else the durable DSH client preference,
 * else `en`) when the caller does not supply one.
 */
import type { RecordLanguage } from "./record-language.js";

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
