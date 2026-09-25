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

	it("requires title and content for create; updates carry any non-empty subset (B3/B5)", () => {
		expect(validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "", content: "c" }), undefined)).toMatch(/title and content/);
		// update is a partial-update contract: apply merges with the persisted
		// entry, so a content-only (or metadata-only) update is valid —
		// evolve_update's own description, skill archive/demote, and
		// consolidate all rely on it.
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", content: "c" }), undefined)).toBeUndefined();
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", metadata: { k: 1 } }), undefined)).toBeUndefined();
		// an update carrying nothing is a no-op and is rejected
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x" }), undefined)).toMatch(/carries no changes/);
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
		expect(validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" } }), undefined)).toBeUndefined();
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

	it("rejects skill content that opens with a frontmatter block", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "---\nname: x\n---\n\nbody",
					arguments: {},
					reference: { type: "python", import: "pkg.mod", callable: "run" },
				}),
				undefined,
			),
		).toMatch(/must not start with a `---`/);
	});

	it("rejects skill content with escaping resource references", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "Run `references/../../etc/x.md`.",
					arguments: {},
					reference: { type: "python", import: "pkg.mod", callable: "run" },
				}),
				undefined,
			),
		).toMatch(/escapes the skill directory/);
	});

	it("accepts a guidance skill without a python reference", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "handoff",
					title: "会话交接流程",
					content: "# 交接流程\n\n开始读交接文档，结束写交接文档。",
					skill_kind: "guidance",
				}),
				undefined,
			),
		).toBeUndefined();
	});

	it("rejects a guidance skill carrying a python reference", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "body",
					skill_kind: "guidance",
					reference: { type: "python", import: "pkg.mod", callable: "run" },
				}),
				undefined,
			),
		).toMatch(/guidance skill must not carry a python reference/);
	});

	it("rejects a guidance skill carrying an arguments contract", () => {
		expect(
			validateEdit(
				edit({
					action: "create",
					kind: "skill",
					id: "s",
					title: "t",
					content: "body",
					skill_kind: "guidance",
					arguments: { input: { type: "string", required: true } },
				}),
				undefined,
			),
		).toMatch(/guidance skill must not carry an arguments contract/);
	});

	it("keeps the executable contract mandatory for skills without skill_kind", () => {
		expect(
			validateEdit(
				edit({ action: "create", kind: "skill", id: "s", title: "t", content: "body", arguments: {} }),
				undefined,
			),
		).toMatch(/requires python reference/);
	});
});

describe("validateEdit blastRadius/scope coherence (C2)", () => {
	it("rejects a local-scope edit that claims general blast radius", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "general" }), undefined, "local"),
		).toMatch(/local-scope edit must declare blastRadius/);
	});

	it("rejects a global-scope edit that claims session blast radius", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "session" }), undefined, "global"),
		).toMatch(/global-scope edit must declare blastRadius/);
	});

	it("accepts coherent combinations", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "session" }), undefined, "local"),
		).toBeUndefined();
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "project" }), undefined, "local"),
		).toBeUndefined();
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "general" }), undefined, "global"),
		).toBeUndefined();
	});

	it("does not enforce when blastRadius is absent (pre-C2 compatibility)", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" } }), undefined, "local"),
		).toBeUndefined();
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" } }), undefined, "global"),
		).toBeUndefined();
	});

	it("does not enforce when scope is unknown to the validator", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "general" }), undefined),
		).toBeUndefined();
	});

	it("rejects a project-scope edit that claims session blast radius", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "session" }), undefined, "project"),
		).toMatch(/project-scope edit must declare blastRadius/);
		expect(
			validateEdit(edit({ action: "create", kind: "memory", id: "x", title: "t", content: "c", metadata: { memoryType: "reference" }, blastRadius: "project" }), undefined, "project"),
		).toBeUndefined();
	});
});

describe("validateEdit memory shape (one-fact typed memories)", () => {
	it("rejects memory creates without a recall type", () => {
		expect(validateEdit(edit({ action: "create", kind: "memory", title: "t", content: "c" }), undefined)).toMatch(/metadata\.memoryType/);
		expect(
			validateEdit(edit({ action: "create", kind: "memory", title: "t", content: "c", metadata: { memoryType: "vibe" } }), undefined),
		).toMatch(/metadata\.memoryType/);
	});

	it("accepts every closed recall type", () => {
		for (const memoryType of ["user", "reference"] as const) {
			expect(
				validateEdit(edit({ action: "create", kind: "memory", title: "t", content: "fact", metadata: { memoryType } }), undefined),
			).toBeUndefined();
		}
	});

	it("requires Why + How on feedback/project creates", () => {
		expect(
			validateEdit(edit({ action: "create", kind: "memory", title: "t", content: "bare fact", metadata: { memoryType: "feedback" } }), undefined),
		).toMatch(/Why/);
		expect(
			validateEdit(
				edit({ action: "create", kind: "memory", title: "oxlint beats eslint here", content: "Use oxlint. Why: 50x faster on this repo. How to apply: run pnpm lint.", metadata: { memoryType: "feedback" } }),
				undefined,
			),
		).toBeUndefined();
		expect(
			validateEdit(
				edit({ action: "create", kind: "memory", title: "t", content: "goal. Why: x. How to apply: y.", metadata: { memoryType: "project" } }),
				undefined,
			),
		).toBeUndefined();
	});

	it("checks carried fields on update against the persisted entry", () => {
		// invalid type on update is rejected even though other fields pass
		expect(
			validateEdit(edit({ action: "update", kind: "memory", id: "x", metadata: { memoryType: "vibe" } }), undefined),
		).toMatch(/memoryType/);
		// content rewritten on a feedback entry must keep the structure
		const before = { metadata: { memoryType: "feedback" } } as unknown as Parameters<typeof validateEdit>[3];
		expect(
			validateEdit(edit({ action: "update", kind: "memory", id: "x", content: "bare fact" }), undefined, undefined, before),
		).toMatch(/Why/);
		expect(
			validateEdit(edit({ action: "update", kind: "memory", id: "x", content: "Why: x. How to apply: y." }), undefined, undefined, before),
		).toBeUndefined();
	});
});

describe("validateEdit update-only paths (round 6)", () => {
	it("resolves an untyped memory update without a persisted type to no type", () => {
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", title: "t" }), undefined, "local", undefined)).toBeUndefined();
		const bareBefore = {} as unknown as Parameters<typeof validateEdit>[3];
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", title: "t" }), undefined, "local", bareBefore)).toBeUndefined();
		const typedBefore = { metadata: { other: 1 } } as unknown as Parameters<typeof validateEdit>[3];
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", title: "t" }), undefined, "local", typedBefore)).toBeUndefined();
		const feedbackBefore = { metadata: { memoryType: "feedback" } } as unknown as Parameters<typeof validateEdit>[3];
		expect(validateEdit(edit({ action: "update", kind: "memory", id: "x", title: "t" }), undefined, "local", feedbackBefore)).toBeUndefined();
	});

	it("resolves a typeless non-update memory edit to no type", () => {
		expect(validateEdit(edit({ action: "delete", kind: "memory", id: "x" }), undefined)).toBeUndefined();
	});

	it("runs the full skill contract on updates carrying a reference", () => {
		const good = edit({
			action: "update",
			kind: "skill",
			id: "s",
			reference: { type: "python", import: "pkg.mod", callable: "run" },
			arguments: { input: "x" },
		});
		expect(validateEdit(good, undefined)).toBeUndefined();
	});

	it("accepts the legacy python_import / call_pattern spellings on update", () => {
		const legacy = edit({
			action: "update",
			kind: "skill",
			id: "s",
			reference: { type: "python", python_import: "pkg.mod", call_pattern: "run" },
			arguments: {},
		});
		expect(validateEdit(legacy, undefined)).toBeUndefined();
	});

	it("rejects an update reference without any import", () => {
		const noImport = edit({ action: "update", kind: "skill", id: "s", reference: { type: "python" }, arguments: {} });
		expect(validateEdit(noImport, undefined)).toMatch(/requires python import/);
	});

	it("checks carried content on skill updates", () => {
		expect(validateEdit(edit({ action: "update", kind: "skill", id: "s", content: "---\nname: x\n---\nbody" }), undefined)).toMatch(
			/must not start with a `---`/,
		);
		expect(validateEdit(edit({ action: "update", kind: "skill", id: "s", content: "# Fine body" }), undefined)).toBeUndefined();
	});
});
