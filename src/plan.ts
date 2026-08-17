/**
 * Parsing helpers for the model-produced proposal JSON. A planner reply is
 * untrusted text: it may carry prose, a fenced block, or be truncated by an
 * exhausted output budget. These helpers recover the JSON object when
 * possible and name the cause (truncation vs malformed) when not.
 */
import type { RefinementEdit, RefinementProposal } from "./types.js";

/** True when the text ends mid-string or with unclosed brackets. */
export function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

/** Parse a JSON candidate, distinguishing truncation from malformation. */
export function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate) as unknown;
	} catch (error) {
		if (isIncompleteJson(candidate)) {
			throw new Error("the model stopped before completing its JSON object (output budget exhausted?)");
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Recover a JSON object from raw model text. */
export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1]?.trim() ?? "");
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error("the model stopped before completing its JSON object (output budget exhausted?)");
	}
	throw new Error("the planner did not return a JSON object");
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Assign a string field only when it is present, honoring exactOptionalPropertyTypes. */
function assignIfString(target: RefinementEdit, key: "id" | "title" | "content" | "path" | "reason", value: unknown): void {
	const str = asString(value);
	if (str !== undefined) {
		target[key] = str;
	}
}

/** Parse and shape a proposal, dropping non-object edits. */
export function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	const record = asRecord(value);
	if (!record) {
		throw new Error("the planner JSON must be an object");
	}
	const edits: RefinementEdit[] = [];
	if (Array.isArray(record["edits"])) {
		for (const raw of record["edits"]) {
			const edit = asRecord(raw);
			if (!edit) continue;
			const built: RefinementEdit = {
				action: asString(edit["action"]) as RefinementEdit["action"],
				kind: asString(edit["kind"]) as RefinementEdit["kind"],
			};
			assignIfString(built, "id", edit["id"]);
			assignIfString(built, "title", edit["title"]);
			assignIfString(built, "content", edit["content"]);
			assignIfString(built, "path", edit["path"]);
			assignIfString(built, "reason", edit["reason"]);
			// Gap C2: validate blastRadius values.
			const br = asString(edit["blastRadius"]);
			if (br === "general" || br === "project" || br === "session") {
				built.blastRadius = br;
			}
			const reference = asRecord(edit["reference"]);
			if (reference) built.reference = reference;
			const argumentsRecord = asRecord(edit["arguments"]);
			if (argumentsRecord) built.arguments = argumentsRecord;
			const metadata = asRecord(edit["metadata"]);
			if (metadata) built.metadata = metadata;
			edits.push(built);
		}
	}
	return {
		summary: asString(record["summary"]) ?? "Refined harness state",
		rationale: asString(record["rationale"]) ?? "",
		expectedOutcome: asString(record["expectedOutcome"]) ?? "",
		edits,
	};
}
