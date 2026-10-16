import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLedgerStmts } from "../src/data/ledger.js";
import { migrateDatabase } from "../src/data/migrate.js";
import { openRepositories } from "../src/data/repository.js";
import { applyProposals, type ProposalContext } from "../src/services/memory-apply.js";
import { applyPromptBatch } from "../src/services/prompt-apply.js";
import { applySkillBatch, type SkillFileOps } from "../src/services/skill-apply.js";

/**
 * An audit row that refuses to be written, the shape 2026-10-16 took: the
 * statement itself is what fails, so nothing but a rollback can keep the
 * store honest.
 */
function refusingLedger(): StatementSync {
	return {
		run() {
			throw new Error("audit write refused");
		},
	} as unknown as StatementSync;
}

let roots: string[] = [];

function tmpDb(): DatabaseSync {
	const root = mkdtempSync(join(tmpdir(), "evolve-audit-"));
	roots.push(root);
	const database = new DatabaseSync(join(root, "t.db"));
	migrateDatabase(database);
	return database;
}

function ledgerRows(database: DatabaseSync, table: string): Record<string, unknown>[] {
	return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

const WORKSPACE = "/tmp/work/audit-tests";
const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify" };

describe("the memory channel", () => {
	it("rolls the batch back when its audit row cannot be written", () => {
		const database = tmpDb();
		try {
			const { memories } = openRepositories(database);
			const ledger = prepareLedgerStmts(database).ledger;
			const ctx: ProposalContext = { workspaceId: WORKSPACE, trigger: "explicit", sessionId: "s1" };
			const apply = (statement: StatementSync, proposals: Parameters<typeof applyProposals>[2], now = "2026-10-16T00:00:00.000Z") =>
				applyProposals({ database, now: () => now, memories, ledger: statement }, ctx, proposals);

			apply(ledger, [{ action: "create", id: "deploy", type: "reference", ...FIELDS }]);

			expect(() => apply(refusingLedger(), [{ action: "update", id: "deploy", body: "rewritten" }])).toThrow(/audit write refused/);

			// The body the model proposed is not in the store, and the connection
			// is not left holding an open transaction.
			expect(memories.getRow(WORKSPACE, "deploy")?.body).toBe(FIELDS.body);
			apply(ledger, [{ action: "update", id: "deploy", body: "landed later" }]);
			expect(memories.getRow(WORKSPACE, "deploy")?.body).toBe("landed later");
			expect(ledgerRows(database, "extraction_log")).toHaveLength(2);
		} finally {
			database.close();
		}
	});
});

describe("the prompt channel", () => {
	it("rolls the batch back when its audit row cannot be written", () => {
		const database = tmpDb();
		try {
			const { prompts } = openRepositories(database);
			const promptLog = prepareLedgerStmts(database).promptLog;
			const ctx: ProposalContext = { workspaceId: WORKSPACE, trigger: "explicit" };
			const apply = (statement: StatementSync, proposals: Parameters<typeof applyPromptBatch>[4]) =>
				applyPromptBatch(prompts, database, statement, ctx, proposals);

			apply(promptLog, [{ action: "create", id: "checklist", ...FIELDS }]);
			expect(() => apply(refusingLedger(), [{ action: "update", id: "checklist", body: "rewritten" }])).toThrow(/audit write refused/);

			expect(prompts.getRow(WORKSPACE, "checklist")?.body).toBe(FIELDS.body);
			expect(ledgerRows(database, "prompt_log")).toHaveLength(1);
			apply(promptLog, [{ action: "update", id: "checklist", body: "landed later" }]);
			expect(prompts.getRow(WORKSPACE, "checklist")?.body).toBe("landed later");
		} finally {
			database.close();
		}
	});
});

describe("the skill channel", () => {
	function fileOps(overrides: Partial<SkillFileOps> = {}): SkillFileOps {
		return {
			rootOf: () => "/tmp/unused-skill-root",
			writeFile: () => [],
			removeFile: () => [],
			...overrides,
		};
	}

	it("rolls the batch back when its audit row cannot be written", () => {
		const database = tmpDb();
		try {
			const { skills } = openRepositories(database);
			const skillLog = prepareLedgerStmts(database).skillLog;
			const ctx: ProposalContext = { workspaceId: WORKSPACE, trigger: "explicit" };
			const apply = (statement: StatementSync, proposals: Parameters<typeof applySkillBatch>[4]) =>
				applySkillBatch(skills, database, statement, ctx, proposals, fileOps());

			apply(skillLog, [{ action: "create", id: "deploy", ...FIELDS }]);
			expect(() => apply(refusingLedger(), [{ action: "update", id: "deploy", body: "rewritten" }])).toThrow(/audit write refused/);

			expect(skills.getRow(WORKSPACE, "deploy")?.body).toBe(FIELDS.body);
			expect(ledgerRows(database, "skill_log")).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	it("records the file warnings in the same transaction as the rows", () => {
		const database = tmpDb();
		try {
			const { skills } = openRepositories(database);
			const skillLog = prepareLedgerStmts(database).skillLog;
			const warnings = [{ id: "deploy", warning: "deploy: file write failed, patrol will retry" }];

			const result = applySkillBatch(
				skills,
				database,
				skillLog,
				{ workspaceId: WORKSPACE, trigger: "explicit" },
				[{ action: "create", id: "deploy", ...FIELDS }],
				fileOps({ writeFile: () => warnings }),
			);

			expect(result.warnings).toEqual(warnings);
			const row = ledgerRows(database, "skill_log")[0];
			expect(row?.status).toBe("applied");
			expect(JSON.parse(String(row?.warnings))).toEqual(warnings);
		} finally {
			database.close();
		}
	});

	it("keeps landable rows when the projection itself throws", () => {
		const database = tmpDb();
		try {
			const { skills } = openRepositories(database);
			const skillLog = prepareLedgerStmts(database).skillLog;

			const result = applySkillBatch(
				skills,
				database,
				skillLog,
				{ workspaceId: WORKSPACE, trigger: "explicit" },
				[{ action: "create", id: "deploy", ...FIELDS }],
				fileOps({
					rootOf: () => {
						throw new Error("no home directory");
					},
				}),
			);

			expect(result.outcomes).toEqual([{ id: "deploy", action: "create", ok: true }]);
			expect(result.warnings).toEqual([
				{ id: "deploy", warning: "skill deploy: file sync threw, patrol will retry: no home directory" },
			]);
			const row = ledgerRows(database, "skill_log")[0];
			expect(row?.status).toBe("applied");
			expect(JSON.parse(String(row?.warnings))).toEqual(result.warnings);
		} finally {
			database.close();
		}
	});
});

describe("the rejected path", () => {
	it("still lands a row after the rollback, with nothing to undo", () => {
		const database = tmpDb();
		try {
			const { memories } = openRepositories(database);
			const ledger = prepareLedgerStmts(database).ledger;

			applyProposals(
				{ database, now: () => "2026-10-16T00:00:00.000Z", memories, ledger },
				{ workspaceId: WORKSPACE, trigger: "explicit" },
				[{ action: "update", id: "absent", body: "b" }],
			);

			expect(memories.getRow(WORKSPACE, "absent")).toBeUndefined();
			const row = ledgerRows(database, "extraction_log")[0];
			expect(row?.status).toBe("rejected");
			expect(String(row?.decision)).toContain("first failure");
		} finally {
			database.close();
		}
	});
});
