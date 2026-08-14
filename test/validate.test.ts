/**
 * Tests for edit validation: enum membership, base-prompt immutability,
 * required fields per action, and the skill executable contract.
 */
import { describe, expect, it } from "vitest";
import { BASE_SYSTEM_PROMPT_ID, validateEdit } from "../src/validate.js";
import type { RefinementEdit } from "../src/types.js";

function edit(overrides: Partial<RefinementEdit> & Pick<RefinementEdit, "action" | "kind">): RefinementEdit {
	return { ...overrides };
}

describe("validateEdit", () => {
	it("rejects unknown action", () => {
		expect(validateEdit(edit({ action: "explode" as never, kind: "memory" }), undefined)).toMatch(/unsupported action/);
	});

	it("rejects unknown kind", () => {
		expect(validateEdit(edit({ action: "create", kind: "config" as never }), undefined)).toMatch(/unsupported kind/);
	});

	it("refuses to edit the base system prompt", () => {
		const e = edit({ action: "update", kind: "prompt", id: BASE_SYSTEM_PROMPT_ID, title: "x", content: "y" });
		expect(validateEdit(e, undefined)).toMatch(/not editable/);
		// also rejects when the computed id collides
		expect(validateEdit({ ...e, id: undefined }, BASE_SYSTEM_PROMPT_ID)).toMatch(/not editable/);
	});

	it("requires id for update/delete", () => {
		expect(validateEdit(edit({ action: "update", kind: "memory", title: "t", content: "c" }), undefined)).toMatch(/requires id/);
		expect(validateEdit(edit({ action: "delete", kind: "memory" }), undefined)).toMatch(/requires id/);
	});

	it("requires title and content for create/update", () => {
		expect(validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "", content: "c" }), undefined)).toMatch(/title and content/);
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", title: "t", content: "" }), undefined)).toMatch(/title and content/);
	});

	it("accepts archive with only kind + id, rejects it without id", () => {
		expect(validateEdit(edit({ action: "archive", kind: "memory", id: "x" }), undefined)).toBeUndefined();
		expect(validateEdit(edit({ action: "archive", kind: "memory" }), undefined)).toMatch(/requires id/);
	});

	it("rejects archive of the base system prompt", () => {
		const e = edit({ action: "archive", kind: "prompt", id: BASE_SYSTEM_PROMPT_ID });
		expect(validateEdit(e, undefined)).toMatch(/not editable/);
	});

	it("accepts a valid memory create", () => {
		expect(validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c" }), undefined)).toBeUndefined();
	});

	it("requires arguments + python reference with import and callable for skills", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "skill", id: "s", title: "t", content: "c" }), undefined),
		).toMatch(/requires arguments/);
		expect(
			validateEdit(
				edit({ action: "create", kind: "skill", id: "s", title: "t", content: "c", arguments: {} }),
				undefined,
			),
		).toMatch(/requires python reference/);
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "c",
					arguments: {},
					reference: { type: "python", import: "pkg.mod" },
				}),
				undefined,
			),
		).toMatch(/callable or call_pattern/);
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "c",
					arguments: {},
					reference: { type: "python", import: "pkg.mod", callable: "run" },
				}),
				undefined,
			),
		).toBeUndefined();
	});

	it("rejects non-python reference type", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "c",
					arguments: {},
					reference: { type: "shell", import: "x" },
				}),
				undefined,
			),
		).toMatch(/must be python/);
	});
});
