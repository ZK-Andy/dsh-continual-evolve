#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Offline recall evaluation: seed a throwaway store from a fixture, run each
 * query through the store's own keyword search, and report hit@1 with MRR
 * (ADR `2026-10-18-absorb-memory-plugin-strengths`, borrowed from the
 * reproducible-benchmark habit of 灵枢 / dsh-engram).
 *
 * Why it exists: retrieval changes (tokenizer, ordering, budget, caveats) had no
 * before/after judgement — only vibes in a hand-kept ledger. This is the
 * judgement, and it never touches the real database: the store is opened under
 * a temporary directory and removed afterwards.
 *
 * Usage:
 *   npm run eval:recall                 # default fixture
 *   npm run eval:recall -- <fixture>    # another fixture file
 *
 * Exit codes: 0 = measured (whatever the number), 1 = the fixture is unusable
 * (missing, empty, or naming an unknown memory) — an empty fixture must be red,
 * never a silent 100%.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore } from "../src/store.js";

interface FixtureMemory {
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	notWhen?: string;
}

interface FixtureQuery {
	q: string;
	expect: string;
}

interface Fixture {
	memories: FixtureMemory[];
	queries: FixtureQuery[];
}

const DEFAULT_FIXTURE = join(import.meta.dirname, "..", "test", "fixtures", "recall", "queries.json");
const WORKSPACE = "/tmp/evolve-recall-eval";

/** Read and validate the fixture; throws with a readable reason. */
function loadFixture(path: string): Fixture {
	let raw: Fixture;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	} catch (error) {
		throw new Error(`cannot read fixture ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(raw.memories) || raw.memories.length === 0) {
		throw new Error(`fixture ${path} has no memories — an empty fixture measures nothing`);
	}
	if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
		throw new Error(`fixture ${path} has no queries — an empty fixture measures nothing`);
	}
	const known = new Set(raw.memories.map((memory) => memory.id));
	for (const query of raw.queries) {
		if (!known.has(query.expect)) {
			throw new Error(`query "${query.q}" expects unknown memory "${query.expect}"`);
		}
	}
	return raw;
}

/** Seed the throwaway store and run every query; returns the report lines. */
async function run(fixture: Fixture): Promise<{ hit1: number; mrr: number; lines: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "evolve-recall-"));
	const store = await openMemoryStore(join(dir, "memory.db"));
	try {
		const outcomes = store.applyProposals(
			{ workspaceId: WORKSPACE, trigger: "explicit" },
			fixture.memories.map((memory) => ({
				action: "create" as const,
				id: memory.id,
				type: memory.type,
				title: memory.title,
				description: memory.description,
				body: memory.body,
				notWhen: memory.notWhen,
			})),
		);
		const rejected = outcomes.filter((outcome) => !outcome.ok);
		if (rejected.length > 0) {
			throw new Error(`fixture memory rejected by the write gate: ${rejected[0]?.reason ?? "unknown"}`);
		}
		const lines: string[] = [];
		let hit1 = 0;
		let reciprocal = 0;
		for (const query of fixture.queries) {
			const results = store.search(WORKSPACE, query.q, 10);
			const rank = results.findIndex((record) => record.id === query.expect);
			if (rank === 0) {
				hit1 += 1;
			}
			if (rank >= 0) {
				reciprocal += 1 / (rank + 1);
			}
			const top = results[0]?.id ?? "(none)";
			lines.push(`${rank === 0 ? "hit " : rank > 0 ? `top${String(rank + 1)}` : "miss"}  q=${query.q}  expect=${query.expect}  got=${top}`);
		}
		return { hit1: hit1 / fixture.queries.length, mrr: reciprocal / fixture.queries.length, lines };
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const path = process.argv[2] ?? DEFAULT_FIXTURE;
	const fixture = loadFixture(path);
	const { hit1, mrr, lines } = await run(fixture);
	for (const line of lines) {
		console.log(line);
	}
	console.log(`\nqueries=${String(fixture.queries.length)}  memories=${String(fixture.memories.length)}`);
	console.log(`hit@1=${(hit1 * 100).toFixed(1)}%  MRR=${mrr.toFixed(3)}`);
}

main().catch((error: unknown) => {
	console.error(`eval:recall failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
