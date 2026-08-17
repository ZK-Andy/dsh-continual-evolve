/**
 * Code-enforced validation of model-proposed edits. Every rule here exists
 * because the proposal is untrusted input: enum membership, immutability of
 * the base system prompt, required fields per action, and the executable
 * contract skill entries must carry.
 */
import type { HarnessScope, PythonReference, RefinementEdit, RefinementKind } from "./types.js";
import { validateSkillEntryContent } from "./skillquality.js";

const ACTIONS = new Set(["create", "update", "delete", "archive"]);
const KINDS = new Set<RefinementKind>(["prompt", "memory", "skill", "subagent"]);
export const BASE_SYSTEM_PROMPT_ID = "base_system_prompt";

/**
 * Gap C2: mechanical check that an edit's declared blast radius is coherent
 * with the scope it targets. A session-scoped edit claiming "general" would
 * silently read like a cross-project tactical rule; a global edit claiming
 * "session" would contradict its persistence. Absent blastRadius is NOT
 * rejected (pre-C2 data and manual edits stay compatible) — the planner is
 * instructed to always declare it, and this rule catches what it declares
 * incoherently.
 */
export function validateBlastRadiusScope(
	scope: HarnessScope,
	blastRadius: "general" | "project" | "session",
): string | undefined {
	if (scope === "local" && blastRadius === "general") {
		return "local-scope edit must declare blastRadius \"session\" or \"project\" (\"general\" would claim a cross-project rule)";
	}
	if (scope === "global" && blastRadius === "session") {
		return "global-scope edit must declare blastRadius \"general\" or \"project\" (\"session\" contradicts cross-session persistence)";
	}
	return undefined;
}

/** Returns a human-readable failure reason, or undefined when the edit passes. */
export function validateEdit(edit: RefinementEdit, computedId: string | undefined, scope?: HarnessScope): string | undefined {
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
	// Gap C2: blast-radius/scope coherence is a mechanical property of the
	// edit payload itself — checked for every action, not only create/update.
	if (scope && edit.blastRadius !== undefined) {
		const blastError = validateBlastRadiusScope(scope, edit.blastRadius);
		if (blastError) return blastError;
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
		// Guidance skills are SKILL.md documents: no python reference (a
		// reference on a guidance skill would be an invented contract) and
		// no arguments contract. Executable skills keep the full contract.
		if (edit.skill_kind === "guidance") {
			if (edit.reference !== undefined && Object.keys(edit.reference).length > 0) {
				return "guidance skill must not carry a python reference (it is a SKILL.md document, not an executable)";
			}
			if (edit.arguments !== undefined && Object.keys(edit.arguments).length > 0) {
				return "guidance skill must not carry an arguments contract (only executable skills declare inputs)";
			}
		} else {
			const contractError = validateSkillContract(edit);
			if (contractError) return contractError;
		}
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
