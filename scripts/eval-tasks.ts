#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Offline eval task commands (P5a): list, validate, and subset the
 * `evals/tasks/*.json` regression set without any model call. The online
 * runner (four arms, judges) lands in P5b — this file never touches a model.
 *
 * Usage:
 *   pnpm eval:tasks --list             # task count + expect-kind distribution
 *   pnpm eval:tasks --dry-run          # validate every task (schema + recall refs)
 *   pnpm eval:tasks --dry-run --subset 10   # validate the first 10 only
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TASKS_DIR = join(import.meta.dirname, "..", "evals", "tasks");
const EXPECT_KINDS = ["file-exists", "test-pass", "output-contains"] as const;

export interface TaskSummary {
	readonly id: string;
	readonly tags: readonly string[];
	readonly expectKinds: readonly string[];
	readonly hasRecall: boolean;
	readonly negative: boolean;
}

export interface TaskValidation {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly summaries: readonly TaskSummary[];
}

/** Load and validate task files (pure, importable by tests). */
export function validateTasks(files: readonly { name: string; text: string }[]): TaskValidation {
	const errors: string[] = [];
	const summaries: TaskSummary[] = [];
	const seenIds = new Set<string>();
	for (const { name, text } of files) {
		let task: Record<string, unknown>;
		try {
			task = JSON.parse(text) as Record<string, unknown>;
		} catch {
			errors.push(`${name}: not valid JSON`);
			continue;
		}
		const id = task.id;
		if (typeof id !== "string" || id.length === 0) {
			errors.push(`${name}: missing id`);
			continue;
		}
		if (seenIds.has(id)) {
			errors.push(`${name}: duplicate task id "${id}"`);
			continue;
		}
		seenIds.add(id);
		if (typeof task.prompt !== "string" || task.prompt.length === 0) {
			errors.push(`${name}: task "${id}" missing prompt`);
		}
		const expect = task.expect;
		if (!Array.isArray(expect) || expect.length === 0) {
			errors.push(`${name}: task "${id}" needs at least one expect criterion`);
		} else {
			for (const criterion of expect) {
				const kind = (criterion as { kind?: unknown } | null)?.kind;
				if (typeof kind !== "string" || !(EXPECT_KINDS as readonly string[]).includes(kind)) {
					errors.push(`${name}: task "${id}" has an unknown expect kind (want ${EXPECT_KINDS.join("/")})`);
				}
			}
		}
		const recall = task.recall as { query?: unknown; expect_ids?: unknown; negative?: unknown } | undefined;
		let hasRecall = false;
		let negative = false;
		if (recall !== undefined) {
			hasRecall = true;
			negative = recall.negative === true;
			if (!Array.isArray(recall.expect_ids)) {
				errors.push(`${name}: task "${id}" recall needs expect_ids (empty for negatives)`);
			} else if (negative && recall.expect_ids.length > 0) {
				errors.push(`${name}: task "${id}" is negative but names expect_ids`);
			} else if (!negative && recall.expect_ids.length === 0) {
				errors.push(`${name}: task "${id}" is not negative but names no expect_ids`);
			}
		}
		summaries.push({
			id,
			tags: Array.isArray(task.tags) ? (task.tags as unknown[]).filter((tag): tag is string => typeof tag === "string") : [],
			expectKinds: Array.isArray(expect) ? expect.map((criterion) => String((criterion as { kind?: unknown } | null)?.kind ?? "?")) : [],
			hasRecall,
			negative,
		});
	}
	return { ok: errors.length === 0, errors, summaries };
}

/** Read every task file from a directory. */
function readTaskFiles(dir: string): { name: string; text: string }[] {
	const stat = statSync(dir);
	const files = stat.isDirectory()
		? readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name))
		: [dir];
	return files.map((file) => ({ name: file, text: readFileSync(file, "utf8") }));
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const subsetRaw = argValue("--subset");
	const subset = subsetRaw === undefined ? undefined : Number(subsetRaw);
	if (subset !== undefined && (!Number.isInteger(subset) || subset <= 0)) {
		console.error("eval:tasks failed: --subset needs a positive integer");
		return 1;
	}
	const capped = Number(process.env.EVAL_TASKS_MAX ?? 30);
	let files: { name: string; text: string }[];
	try {
		files = readTaskFiles(TASKS_DIR);
	} catch (error) {
		console.error(`eval:tasks failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (files.length > capped) {
		console.error(`eval:tasks failed: ${String(files.length)} tasks exceed the ${String(capped)}-per-arm cap`);
		return 1;
	}
	const selected = subset === undefined ? files : files.slice(0, subset);
	const validation = validateTasks(selected);
	const kinds: Record<string, number> = {};
	for (const summary of validation.summaries) {
		for (const kind of summary.expectKinds) {
			kinds[kind] = (kinds[kind] ?? 0) + 1;
		}
	}
	console.log(`tasks=${String(validation.summaries.length)}  with-recall=${String(validation.summaries.filter((s) => s.hasRecall).length)}  negatives=${String(validation.summaries.filter((s) => s.negative).length)}`);
	console.log(`expect-kinds: ${Object.entries(kinds).map(([kind, n]) => `${kind}×${String(n)}`).join(" ") || "(none)"}`);
	for (const error of validation.errors) {
		console.error(`eval:tasks invalid: ${error}`);
	}
	return validation.ok ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`eval:tasks failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
