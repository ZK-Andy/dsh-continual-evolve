/**
 * The eval task set the host-plane runner reads (P5b): the same
 * `evals/tasks/*.json` fixtures `scripts/eval-tasks.ts` validates offline,
 * loaded at runtime from the shipped package. Fixture schema knowledge lives
 * here for the online path and in the script for the offline path — the two
 * stay in sync through the shared seed fixtures, not imports (`scripts/` is
 * never published, so `src/` cannot depend on it).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The three executable判据 kinds (mirror of the offline validator). */
export const EVAL_EXPECT_KINDS = ["file-exists", "test-pass", "output-contains"] as const;

/** One executable判据. */
export interface EvalExpect {
	readonly kind: (typeof EVAL_EXPECT_KINDS)[number];
	readonly path?: string | undefined;
	readonly cmd?: string | undefined;
	readonly any?: readonly string[] | undefined;
}

/** The recall/QA segment: the deterministic stand-in for judge-type QA (D10). */
export interface EvalRecall {
	readonly query?: string | undefined;
	readonly expectIds: readonly string[];
	readonly negative?: boolean | undefined;
}

/** One regression task. */
export interface EvalTask {
	readonly id: string;
	readonly from: string;
	readonly prompt: string;
	readonly expect: readonly EvalExpect[];
	readonly tags: readonly string[];
	readonly recall?: EvalRecall | undefined;
}

/** A task-set load: tasks plus the reasons rejected files gave. */
export interface TasksetLoad {
	readonly tasks: EvalTask[];
	readonly errors: string[];
}

/** Upper bound per arm (same cap the offline validator enforces). */
export const EVAL_TASKS_MAX_DEFAULT = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringsOf(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? [...value] : undefined;
}

/**
 * Validate one parsed task file.
 * @param name - The file name (error provenance only).
 * @param raw - The parsed JSON value.
 * @returns The task, or the reason it was rejected.
 */
export function validateEvalTask(name: string, raw: unknown): { task?: EvalTask | undefined; error?: string | undefined } {
	if (!isRecord(raw)) {
		return { error: `${name}: task is not an object` };
	}
	const id = raw.id;
	const prompt = raw.prompt;
	if (typeof id !== "string" || id.length === 0) {
		return { error: `${name}: missing string id` };
	}
	if (typeof prompt !== "string" || prompt.length === 0) {
		return { error: `${name}: task ${id} has no prompt` };
	}
	const expectRaw = raw.expect;
	if (!Array.isArray(expectRaw) || expectRaw.length === 0) {
		return { error: `${name}: task ${id} has no executable判据` };
	}
	const expect: EvalExpect[] = [];
	for (const entry of expectRaw) {
		if (!isRecord(entry) || typeof entry.kind !== "string" || !(EVAL_EXPECT_KINDS as readonly string[]).includes(entry.kind)) {
			return { error: `${name}: task ${id} carries an unknown判据 kind` };
		}
		expect.push({
			kind: entry.kind as EvalExpect["kind"],
			...(typeof entry.path === "string" ? { path: entry.path } : {}),
			...(typeof entry.cmd === "string" ? { cmd: entry.cmd } : {}),
			...(stringsOf(entry.any) === undefined ? {} : { any: stringsOf(entry.any) }),
		});
	}
	const tags = stringsOf(raw.tags) ?? [];
	let recall: EvalRecall | undefined;
	if (isRecord(raw.recall)) {
		const expectIds = stringsOf(raw.recall.expect_ids) ?? [];
		recall = {
			...(typeof raw.recall.query === "string" ? { query: raw.recall.query } : {}),
			expectIds,
			...(typeof raw.recall.negative === "boolean" ? { negative: raw.recall.negative } : {}),
		};
	}
	return {
		task: {
			id,
			from: typeof raw.from === "string" ? raw.from : "",
			prompt,
			expect,
			tags,
			...(recall === undefined ? {} : { recall }),
		},
	};
}

/**
 * Locate the shipped task directory from this module's own URL: `lib/…`
 * in the installed package and `src/…` in the checkout share one layout.
 * @returns The directory holding the task fixtures.
 */
export function taskDirOfSelf(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals", "tasks");
}

/**
 * Load and validate every task fixture in a directory.
 * @param dir - The directory holding `*.json` fixtures.
 * @param max - Rejection cap (fail loud past it, same as offline).
 * @returns The valid tasks plus per-file rejection reasons.
 */
export function loadTaskset(dir: string, max: number = EVAL_TASKS_MAX_DEFAULT): TasksetLoad {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return { tasks: [], errors: [`task dir unreadable: ${dir}`] };
	}
	if (names.length > max) {
		return { tasks: [], errors: [`${names.length} tasks exceed the ${max}-per-arm cap`] };
	}
	const tasks: EvalTask[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
		} catch {
			errors.push(`${name}: not valid JSON`);
			continue;
		}
		const { task, error } = validateEvalTask(name, raw);
		if (task === undefined || error !== undefined) {
			errors.push(error ?? `${name}: rejected`);
			continue;
		}
		if (seen.has(task.id)) {
			errors.push(`${name}: duplicate task id ${task.id}`);
			continue;
		}
		seen.add(task.id);
		tasks.push(task);
	}
	return { tasks, errors };
}
