import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_ARMS } from "../src/data/records.js";
import { runEvalBatch, type EvalRunDeps } from "../src/services/eval-runner.js";
import { taskDirOfSelf } from "../src/services/eval-taskset.js";
import type { LlmRuntime } from "../src/services/llm-call.js";
import { buildSection } from "../src/surfaces/memory-section.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Seeded-store full integration (P6 patch): the runner tests otherwise run on
 * an empty store, where `recallHit === false` everywhere is an empty
 * assertion. Here 12 fixture seeds go through the real write gate, the full
 * 22-task batch runs on all four arms, and a scripted model answers from the
 * task's own seeds — threading runner ↔ store ↔ retrieval with zero network.
 *
 * The scripted model is an acknowledged stand-in for a real LLM (the same
 * legitimacy as the kitchen-sink fake in `eval-runner.test.ts`): the expected
 * needles stand in for "the model said the right thing given the seeds".
 * What is genuinely measured: `recallHit` (the runner's own `store.search`,
 * uncheatable from the reply) and the plumbing (22 tasks × 4 arms land
 * `eval_cases` rows). Two couplings keep the stand-in honest: replies embed a
 * seed-body snippet (seed-coupled) and the injection excerpt (injection-coupled).
 */

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface RawSeed {
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	notWhen?: string;
}

interface RawTask {
	id: string;
	prompt: string;
	needles: string[];
	seeds: RawSeed[];
}

function loadRawTasks(dir: string): RawTask[] {
	const tasks: RawTask[] = [];
	for (const name of readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.sort()) {
		const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown as {
			id?: unknown;
			prompt?: unknown;
			expect?: { kind?: unknown; any?: unknown }[];
			seed_memories?: RawSeed[];
		};
		if (typeof raw.id !== "string" || typeof raw.prompt !== "string" || !Array.isArray(raw.expect)) {
			throw new Error(`${name} is not an eval task (needs id + prompt + expect)`);
		}
		const needles = raw.expect
			.filter((entry) => entry.kind === "output-contains" && Array.isArray(entry.any))
			.flatMap((entry) => (entry.any as unknown[]).filter((needle): needle is string => typeof needle === "string" && needle.length > 0));
		tasks.push({ id: raw.id, prompt: raw.prompt, needles, seeds: raw.seed_memories ?? [] });
	}
	return tasks;
}

function collectSeeds(tasks: RawTask[]): RawSeed[] {
	const merged = new Map<string, RawSeed>();
	for (const task of tasks) {
		for (const seed of task.seeds) {
			const prior = merged.get(seed.id);
			if (prior !== undefined && (prior.body !== seed.body || prior.title !== seed.title)) {
				throw new Error(`seed "${seed.id}" conflicts between tasks`);
			}
			merged.set(seed.id, seed);
		}
	}
	if (merged.size === 0) {
		throw new Error("no task seeds memories — an empty store measures nothing");
	}
	return [...merged.values()];
}

/** Scripted model: needles + the task's own seed bodies + the injection excerpt. Pure, zero network. */
function seededLlm(byPrompt: Map<string, RawTask>, seen: Map<string, string>): LlmRuntime {
	return {
		stream: async function* (options: unknown) {
			const opts = options as {
				messages?: { content?: { text?: unknown }[] }[];
				system?: unknown;
			};
			const prompt = opts.messages?.map((message) => (message.content ?? []).map((part) => String(part.text ?? "")).join("")).join("\n") ?? "";
			const system = typeof opts.system === "string" ? opts.system : "";
			const task = byPrompt.get(prompt);
			const needles = task?.needles ?? [];
			const bodies = (task?.seeds ?? []).map((seed) => seed.body);
			const text = [...needles, ...bodies, system.slice(0, 500)].join("\n");
			seen.set(prompt, text);
			yield { type: "text-delta", text };
			yield { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

describe("seeded-store full integration", () => {
	it("seeds 12 via the real gate, runs 22 tasks on four arms, recall largely true", async () => {
		const raw = loadRawTasks(taskDirOfSelf());
		expect(raw).toHaveLength(22);
		const seeds = collectSeeds(raw);
		expect(seeds).toHaveLength(12);

		const dir = mkdtempSync(join(tmpdir(), "evolve-seeded-"));
		const store: MemoryStore = await openMemoryStore(join(dir, "memory.db"));
		try {
			const outcomes = store.applyProposals(
				{ workspaceId: REPO, trigger: "explicit" },
				seeds.map((seed) => ({
					action: "create" as const,
					id: seed.id,
					type: seed.type,
					title: seed.title,
					description: seed.description,
					body: seed.body,
					...(seed.notWhen === undefined ? {} : { notWhen: seed.notWhen }),
				})),
			);
			expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);

			const byPrompt = new Map(raw.map((task) => [task.prompt, task]));
			const seen = new Map<string, string>();
			const deps: EvalRunDeps = {
				store,
				llm: seededLlm(byPrompt, seen),
				route: { provider: "test", model: "seeded" },
				sessionId: "seeded-integration",
				today: "2026-10-19T00:00:00.000Z",
				// Production wiring (assemble.ts): base is empty, every other
				// arm renders the real section for this workspace.
				injectionFor: (arm, workspaceId) => {
					if (arm === "base") {
						return { system: "", preview: "" };
					}
					const built = buildSection({ session: { header: { cwd: workspaceId } } }, {
						store,
						maxTokens: 6000,
						guide: true,
						toolsAvailable: true,
					});
					return { system: built.text, preview: built.text };
				},
			};
			const out = await runEvalBatch(deps, {
				workspaceId: REPO,
				repeat: 1,
				runId: "seeded-integration",
				commit: "test",
				budgetCapTokens: 100000000,
			});

			expect(out.report.taskCount).toBe(22);
			expect(out.cases).toBe(22 * 4 * 1);
			expect(out.warnings).toEqual([]);
			expect(out.report.flakyIds).toEqual([]);
			for (const arm of EVAL_ARMS) {
				const passed = out.report.arms[arm].tasks.filter((task) => task.pass).length;
				expect(passed).toBeGreaterThanOrEqual(20);
			}
			// Retrieval genuinely measured: the runner's own store.search
			// against seeded rows (same distribution as eval:recall 73.3%).
			const current = out.report.arms.current;
			expect(current.totals.recallTotal).toBe(18);
			expect(current.totals.recallHits).toBeGreaterThanOrEqual(11);
			// Seed-coupled: the reply for task-001 carries a body snippet, not
			// just the needle — the stand-in really answered from the seeds.
			const task001 = [...byPrompt.values()].find((task) => task.id === "task-001");
			expect(task001).toBeDefined();
			expect(seen.get(task001?.prompt ?? "")).toContain("CI 未绿");
			// Injection-coupled: the reply embeds the real layered section.
			expect(seen.get(task001?.prompt ?? "")).toContain("## ");
		} finally {
			store.close();
		}
	});
});
