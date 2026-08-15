/**
 * Code-enforced validation of model-proposed edits. Every rule here exists
 * because the proposal is untrusted input: enum membership, immutability of
 * the base system prompt, required fields per action, and the executable
 * contract skill entries must carry.
 */
import type { PythonReference, RefinementEdit, RefinementKind } from "./types.js";
import { validateSkillEntryContent } from "./skillquality.js";

const ACTIONS = new Set(["create", "update", "delete", "archive"]);
const KINDS = new Set<RefinementKind>(["prompt", "memory", "skill", "subagent"]);
export const BASE_SYSTEM_PROMPT_ID = "base_system_prompt";

/** Returns a human-readable failure reason, or undefined when the edit passes. */
export function validateEdit(edit: RefinementEdit, computedId: string | undefined): string | undefined {
	if (!ACTIONS.has(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!KINDS.has(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === BASE_SYSTEM_PROMPT_ID || computedId === BASE_SYSTEM_PROMPT_ID)) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	// Archive only names an existing entry: no title/content payload, and the
	// base system prompt stays immutable under every action.
	if (edit.action === "archive") {
		return undefined;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const contractError = validateSkillContract(edit);
		if (contractError) return contractError;
		// The entry body materializes as a SKILL.md under generated
		// frontmatter; content-level mechanics (no shadowing `---`, no
		// escaping resource refs) are code-enforced so a bad body never
		// reaches the store (mirrors skill-creator's validate-frontmatter).
		const contentProblems = validateSkillEntryContent(edit.content ?? "");
		if (contentProblems.length > 0) {
			return contentProblems.join("; ");
		}
	}
	return undefined;
}

function validateSkillContract(edit: RefinementEdit): string | undefined {
	if (edit.arguments === undefined) {
		return "create/update skill requires arguments";
	}
	const reference = edit.reference;
	if (!reference || typeof reference !== "object") {
		return "create/update skill requires python reference";
	}
	const ref = reference as unknown as PythonReference;
	if (ref.type !== "python") {
		return "create/update skill reference.type must be python";
	}
	const hasImport =
		(typeof ref.import === "string" && ref.import.length > 0) ||
		(typeof ref.python_import === "string" && ref.python_import.length > 0);
	const hasCallable =
		(typeof ref.callable === "string" && ref.callable.length > 0) ||
		(typeof ref.call_pattern === "string" && ref.call_pattern.length > 0);
	if (!hasImport) {
		return "create/update skill requires python import";
	}
	if (!hasCallable) {
		return "create/update skill requires callable or call_pattern";
	}
	return undefined;
}
