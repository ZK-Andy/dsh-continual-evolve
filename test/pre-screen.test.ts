import { describe, expect, it } from "vitest";
import { screenProposal, screenProposals, screenSkipReason, type ScreenedExisting } from "../src/services/pre-screen.js";

const longBody = "这条规则说的是：任何发版之前都必须确认 CI 全绿，本地绿不算数。";
const existing: ScreenedExisting[] = [
	{ id: "rule-a", title: "发版纪律", description: "发版前用", body: longBody, notWhen: "" },
];

describe("screenProposal", () => {
	it("keeps a delete unconditionally", () => {
		expect(screenProposal({ action: "delete", id: "rule-a" }, existing)).toEqual({ keep: true });
	});

	it("keeps a create with new content", () => {
		expect(screenProposal({ action: "create", body: "另一条完全不同的规则内容，长度足够通过筛选。" }, existing)).toEqual({
			keep: true,
		});
	});

	it("drops a create whose body duplicates an active memory", () => {
		expect(screenProposal({ action: "create", body: `  ${longBody}  ` }, existing)).toEqual({
			keep: false,
			reason: "duplicate",
		});
	});

	it("keeps a short prohibition (short is not the same as worthless)", () => {
		expect(screenProposal({ action: "create", body: "别用 rm -rf" }, existing)).toEqual({ keep: true });
	});

	it("drops an update that changes nothing", () => {
		expect(
			screenProposal({ action: "update", id: "rule-a", title: "发版纪律", body: longBody }, existing),
		).toEqual({ keep: false, reason: "no-change" });
	});

	it("keeps an update that changes one field", () => {
		expect(screenProposal({ action: "update", id: "rule-a", body: `${longBody}补充一句。` }, existing)).toEqual({
			keep: true,
		});
	});

	it("drops an update targeting an unknown id (P2 identity gate, no longer the store gate's job)", () => {
		expect(screenProposal({ action: "update", id: "absent", body: "x" }, existing)).toEqual({ keep: true });
		expect(screenProposals([{ action: "update", id: "absent", body: "x" }], existing)).toMatchObject({
			kept: [],
			dropped: ["unknown-id"],
		});
	});

	it("drops a create colliding with an active id", () => {
		expect(
			screenProposals([{ action: "create", id: "rule-a", type: "user", title: "t", description: "d", body: "b" }], existing).dropped,
		).toEqual(["id-collision"]);
	});

	it("drops a forged action and a bad type with a counted reason", () => {
		const result = screenProposals(
			[
				{ action: "upsert", id: "x" } as unknown as { action: "create"; id: string },
				{ action: "create", id: "new-x", type: "project", title: "t", description: "d", body: "b" },
			],
			existing,
		);
		expect(result.kept).toHaveLength(0);
		expect(result.dropped).toEqual(["unknown-action", "bad-type"]);
		expect(result.warnings).toEqual([
			{ id: "x", reason: "unknown-action" },
			{ id: "new-x", reason: "bad-type" },
		]);
	});
});

describe("screenProposals", () => {
	it("splits a batch and counts the reasons", () => {
		const result = screenProposals(
			[
				{ action: "create", body: longBody },
				{ action: "create", body: longBody },
				{ action: "create", body: "一条真正新的内容，足够长，能通过筛选门槛。" },
			],
			existing,
		);
		expect(result.kept).toHaveLength(1);
		expect(result.dropped).toEqual(["duplicate", "duplicate"]);
		expect(screenSkipReason(result.dropped)).toBe("pre-screen: duplicate×2");
	});

	it("reports nothing for an empty drop list", () => {
		expect(screenSkipReason([])).toBeUndefined();
	});
});
