/**
 * The mechanical write gates every prompt supplement passes before the
 * store accepts it — the same "模型提议，代码保证" boundary as memories
 * and skills, minus taxonomy and scope: prompts carry no type enum, live
 * only in their workspace partition (no global scope, no move), and take
 * create/update/delete. Sizes, id shape, and secret screening reuse the
 * shared gates in `./memory-rules.js`.
 */
import { MEMORY_BODY_LIMIT, MEMORY_DESCRIPTION_LIMIT, MEMORY_TITLE_LIMIT, secretLeakReason, textFieldGate } from "./memory-rules.js";

export { isValidMemoryId as isValidPromptId, slugifyId as slugifyPromptId } from "./memory-rules.js";

/** One proposed prompt mutation — the closed shape the write paths speak. */
export interface PromptProposal {
	action: "create" | "update" | "delete";
	/** Required for update/delete; optional for create (derived from title). */
	id?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	/** Trajectory provenance ("820-831"), kept for parity with memory proposals. */
	sourceSeqs?: string | undefined;
}

/** The merged field values a create/update would write (delete checks none). */
export interface PromptFields {
	title: string;
	description: string;
	body: string;
}

/**
 * Gates that depend only on the merged field values (not on store state).
 * Runs the secret screen over the full visible text so a secret smuggled
 * into any field blocks the write.
 * @param fields - The merged title/description/body.
 * @returns The blocking reasons, empty when the supplement would pass.
 */
export function promptFieldGateReasons(fields: PromptFields): string[] {
	const reasons: string[] = [];
	for (const reason of [
		textFieldGate(fields.title, "title must not be empty", MEMORY_TITLE_LIMIT, `title exceeds ${MEMORY_TITLE_LIMIT} characters`),
		textFieldGate(
			fields.description,
			"description must not be empty — it is the injection hook",
			MEMORY_DESCRIPTION_LIMIT,
			`description exceeds ${MEMORY_DESCRIPTION_LIMIT} characters`,
		),
		textFieldGate(fields.body, "body must not be empty", MEMORY_BODY_LIMIT, `body exceeds the ${MEMORY_BODY_LIMIT}-character cap`),
	]) {
		if (reason !== undefined) {
			reasons.push(reason);
		}
	}
	const leak = secretLeakReason(`${fields.title}\n${fields.description}\n${fields.body}`);
	if (leak !== undefined) {
		reasons.push(leak);
	}
	return reasons;
}
