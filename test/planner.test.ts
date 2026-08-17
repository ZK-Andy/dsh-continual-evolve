/**
 * Planner trajectory tests: `/evolve plan` grounds the LLM proposal in the
 * session trajectory. The trajectory block is extracted from the calling
 * agent's own session log (same extraction as the injection ranking) unless
 * an explicit `trajectory` is passed, and is omitted entirely when nothing
 * qualifies — keeping an empty trajectory zero-cost.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { HarnessState } from "../src/types.js";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { PLANNER_SYSTEM_PROMPT, planWithLlm, type PlanOptions } from "../src/planner.js";
import { parseProposal } from "../src/plan.js";

describe("PLANNER_SYSTEM_PROMPT", () => {
	it("tells the planner to propose archive instead of delete for stale entries", () => {
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/archive/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/stale/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/instead of\s+"delete"/i);
	});

	it("requires skill entries to follow the DSH skill quality standard", () => {
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/skill quality standard/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/real trigger scenario/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/7 structural features/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/<skill_quality_standard>/);
	});

	it("allows recurring workflows to be proposed as guidance skills", () => {
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/guidance skills/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/skill_kind="guidance"/);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/no\s+python reference/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/repeated evidence/i);
		expect(PLANNER_SYSTEM_PROMPT).toMatch(/offered to\s+the user/i);
	});
});

const emptyState: HarnessState = {
	schema: 1,
	entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
	refinements: [],
};

const emptyProposal = { summary: "no edits", rationale: "nothing durable", expectedOutcome: "none", edits: [] };

/** A fake llm.stream that captures its options and yields a text JSON reply. */
function fakeCtx(): { ctx: Context; captured: { userPrompt: string } } {
	let captured: { userPrompt: string } = { userPrompt: "" };
	const ctx = {
		llm: {
			stream: async function* (options: { messages: Array<{ content: Array<{ type: string; text: string }> }> }) {
				const content = options.messages[0]?.content;
				captured.userPrompt = (content?.find((block) => block.type === "text") as { text: string } | undefined)?.text ?? "";
				const text = JSON.stringify(emptyProposal);
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
	} as unknown as Context;
	return { ctx, captured };
}

function agentWith(events: unknown[]): PlanOptions["agent"] {
	return {
		id: "session-main",
		options: { provider: "test-provider", model: "test-model" },
		session: { events },
	} as unknown as PlanOptions["agent"];
}

const userRow = (seq: number, text: string) => ({
	type: "user/message",
	seq,
	data: { content: [{ type: "text", text }], source: { kind: "user" } },
});

describe("planWithLlm trajectory grounding", () => {
	it("extracts the recent direct user messages into a <session_trajectory> block", async () => {
		const { ctx, captured } = fakeCtx();
		const agent = agentWith([
			userRow(10, "first request"),
			{ type: "user/message", seq: 11, data: { content: [{ type: "text", text: "injected context" }], source: { kind: "plugin", plugin: "x" } } },
			userRow(12, "second request"),
		]);
		await planWithLlm(ctx, { agent, state: emptyState, history: [] });
		expect(captured.userPrompt).toContain("<session_trajectory>");
		expect(captured.userPrompt).toContain("first request");
		expect(captured.userPrompt).toContain("second request");
		expect(captured.userPrompt).not.toContain("injected context");
	});

	it("omits the trajectory block when the agent has no qualifying messages", async () => {
		const { ctx, captured } = fakeCtx();
		await planWithLlm(ctx, { agent: agentWith([]), state: emptyState, history: [] });
		expect(captured.userPrompt).not.toContain("<session_trajectory>");

		const { ctx: ctx2, captured: captured2 } = fakeCtx();
		const onlyToolSource = agentWith([
			{ type: "user/message", seq: 10, data: { content: "tool result", source: { kind: "tool" } } },
			{ type: "user/message", seq: 11, data: { content: "injected", source: { kind: "plugin", plugin: "x" } } },
		]);
		await planWithLlm(ctx2, { agent: onlyToolSource, state: emptyState, history: [] });
		expect(captured2.userPrompt).not.toContain("<session_trajectory>");
	});

	it("prefers an explicit trajectory over the extracted one", async () => {
		const { ctx, captured } = fakeCtx();
		const agent = agentWith([userRow(10, "session text that must not appear")]);
		await planWithLlm(ctx, { agent, state: emptyState, history: [], trajectory: "explicit trajectory" });
		expect(captured.userPrompt).toContain("<session_trajectory>\nexplicit trajectory\n</session_trajectory>");
		expect(captured.userPrompt).not.toContain("session text that must not appear");
	});

	it("keeps the empty trajectory zero-cost and still returns a parsed proposal", async () => {
		const { ctx, captured } = fakeCtx();
		const proposal = await planWithLlm(ctx, { agent: agentWith([]), state: emptyState, history: [] });
		expect(proposal.edits).toEqual([]);
		expect(proposal.summary).toBe("no edits");
		expect(captured.userPrompt).not.toContain("<session_trajectory>");
	});
});

describe("planWithLlm skill quality standard", () => {
	it("always injects the <skill_quality_standard> block (builtin guide without a skills root)", async () => {
		const { ctx, captured } = fakeCtx();
		await planWithLlm(ctx, { agent: agentWith([]), state: emptyState, history: [] });
		expect(captured.userPrompt).toContain("<skill_quality_standard>");
		expect(captured.userPrompt).toContain("7 structural features");
	});

	it("instructs the planner to annotate blastRadius on every edit", () => {
		expect(PLANNER_SYSTEM_PROMPT).toContain("blastRadius");
		expect(PLANNER_SYSTEM_PROMPT).toContain("general");
		expect(PLANNER_SYSTEM_PROMPT).toContain("project");
		expect(PLANNER_SYSTEM_PROMPT).toContain("session");
	});

	it("uses the skill-creator template facts when installed", async () => {
		const root = mkdtempSync(join(process.cwd(), "test/.tmp/"));
		try {
			const dir = join(root, "skill-creator", "references");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "template.md"), "# Marker line\n\nunique-template-fact-123\n", "utf8");
			const { ctx, captured } = fakeCtx();
			await planWithLlm(ctx, { agent: agentWith([]), state: emptyState, history: [], skillsRoot: root });
			expect(captured.userPrompt).toContain("unique-template-fact-123");
			expect(captured.userPrompt).toContain("<skill_quality_standard>");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("parseProposal blastRadius (C2)", () => {
	it("parses valid blastRadius values", () => {
		const text = JSON.stringify({
			summary: "test",
			rationale: "r",
			expectedOutcome: "o",
			edits: [
				{ action: "create", kind: "memory", title: "A", content: "a", blastRadius: "session" },
				{ action: "create", kind: "prompt", title: "B", content: "b", blastRadius: "general" },
				{ action: "create", kind: "memory", title: "C", content: "c", blastRadius: "project" },
			],
		});
		const proposal = parseProposal(text);
		expect(proposal.edits[0]?.blastRadius).toBe("session");
		expect(proposal.edits[1]?.blastRadius).toBe("general");
		expect(proposal.edits[2]?.blastRadius).toBe("project");
	});

	it("drops invalid blastRadius values", () => {
		const text = JSON.stringify({
			summary: "test",
			rationale: "r",
			expectedOutcome: "o",
			edits: [
				{ action: "create", kind: "memory", title: "A", content: "a", blastRadius: "invalid" },
			],
		});
		const proposal = parseProposal(text);
		expect(proposal.edits[0]?.blastRadius).toBeUndefined();
	});

	it("handles missing blastRadius gracefully", () => {
		const text = JSON.stringify({
			summary: "test",
			rationale: "r",
			expectedOutcome: "o",
			edits: [
				{ action: "create", kind: "memory", title: "A", content: "a" },
			],
		});
		const proposal = parseProposal(text);
		expect(proposal.edits[0]?.blastRadius).toBeUndefined();
	});
});
