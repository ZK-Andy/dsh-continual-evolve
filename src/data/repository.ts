/**
 * The generic repository: every managed object (today memories, P2 skills)
 * is the same operations over different SQL. Per-kind SQL lives in the
 * {@link ResourceKind} descriptor the caller passes in; preparation, the
 * FTS-then-LIKE search discipline, FTS sync, and usage accounting are
 * written once here. Table names come from code constants, never user
 * input, so interpolating them is safe.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { MEMORIES, PROMPTS, SKILLS } from "./resource-kinds.js";
import type { MemoryRow, PromptRow, SkillRow } from "./records.js";
import { ftsPhrase, likePattern, queryTokens, searchAlternatives } from "./search-query.js";

/** Bindable column value (the subset of node:sqlite's SQLInputValue we use). */
export type SqlValue = string | number | bigint | null;

/**
 * Everything that differs between two managed objects, as SQL. Execution
 * lives in {@link Repository}; this is only strings plus the search shape.
 */
export interface ResourceKind {
	/** Base table, e.g. `memories`. */
	readonly table: string;
	/** ORDER BY fragment shared by the list-family queries. */
	readonly order: string;
	/** Columns the LIKE fallback matches (title/description/body for both kinds today). */
	readonly likeColumns: readonly string[];
	readonly selectById: string;
	readonly selectActive: string;
	readonly selectVisible: string;
	readonly selectFts: string;
	readonly selectWorkspaces: string;
	/**
	 * Newest-instant probe for the most-recently-active race, `null` when the
	 * kind feeds it from a ledger instead of its own table (skills read
	 * `skill_log`, so only memories declare this).
	 */
	readonly selectRecent: string | null;
	/**
	 * Body-dedupe lookup (`SELECT id … WHERE body = ?`), `null` when the
	 * kind has no same-body gate (only skills dedupe on body today).
	 */
	readonly selectSameBody: string | null;
	readonly selectFtsOrphans: string;
	readonly deleteFtsRow: string;
	readonly selectActiveRows: string;
	readonly updateQuarantine: string;
	readonly insertSql: string;
	readonly updateSql: string;
	readonly deleteSql: string;
	/**
	 * Reason-stamping archive (`UPDATE … SET status = 'archived', archive_reason
	 * = ?, merged_into = ? …`), `null` when the kind has no archive-reason
	 * columns (only memories archives with a reason today).
	 */
	readonly archiveReasonedSql: string | null;
	/**
	 * Correction-pointer follow (`UPDATE … SET corrects = ? WHERE corrects
	 * = ?`), `null` when the kind has no `corrects` column (memories only).
	 */
	readonly repointSql: string | null;
	/**
	 * Trial-clock carry (`UPDATE … SET probation_until = ?,
	 * origin_workspace = ?`), `null` when the kind has no trial columns
	 * (memories only).
	 */
	readonly restoreTrialSql: string | null;
	readonly ftsDropSql: string;
	readonly ftsInsertSql: string;
	readonly usageGetSql: string;
	readonly usageUpsertSql: string;
}

/**
 * Open the three kind repositories over one database handle. The descriptors
 * stay in `resource-kinds.ts`; this factory only binds each one to a
 * prepared repository, so the store assembly stays a thin spread.
 * @param database - The open database handle.
 * @returns The memories/skills/prompts repositories.
 */
export function openRepositories(database: DatabaseSync): {
	memories: Repository<MemoryRow>;
	skills: Repository<SkillRow>;
	prompts: Repository<PromptRow>;
} {
	return {
		memories: new Repository<MemoryRow>(database, MEMORIES),
		skills: new Repository<SkillRow>(database, SKILLS),
		prompts: new Repository<PromptRow>(database, PROMPTS),
	};
}

/**
 * One object's full row access, prepared once per open store. Row mapping
 * stays with the caller (it owns the record types); this class only moves
 * rows and value arrays.
 */
export class Repository<Row> {
	private readonly database: DatabaseSync;
	private readonly kind: ResourceKind;
	private readonly byId: StatementSync;
	private readonly active: StatementSync;
	private readonly visible: StatementSync;
	private readonly fts: StatementSync;
	private readonly workspaces: StatementSync;
	private readonly recentStmt: StatementSync | undefined;
	private readonly sameBodyStmt: StatementSync | undefined;
	private readonly ftsOrphans: StatementSync;
	private readonly ftsDropOne: StatementSync;
	private readonly activeRows: StatementSync;
	private readonly quarantineOne: StatementSync;
	private readonly insertOne: StatementSync;
	private readonly updateOne: StatementSync;
	private readonly deleteOne: StatementSync;
	private readonly ftsDrop: StatementSync;
	private readonly ftsInsert: StatementSync;
	private readonly usageGet: StatementSync;
	private readonly usageUpsert: StatementSync;
	private archiveStmt: StatementSync | undefined;
	/** LIKE fallback: one statement per token count — the query set repeats, the counts don't grow. */
	private readonly likeStmts = new Map<string, StatementSync>();

	/**
	 * Prepare every statement for one kind up front.
	 * @param database - The open database handle.
	 * @param kind - The kind's SQL bundle.
	 */
	constructor(database: DatabaseSync, kind: ResourceKind) {
		this.database = database;
		this.kind = kind;
		this.byId = database.prepare(kind.selectById);
		this.active = database.prepare(kind.selectActive);
		this.visible = database.prepare(kind.selectVisible);
		this.fts = database.prepare(kind.selectFts);
		this.workspaces = database.prepare(kind.selectWorkspaces);
		this.recentStmt = kind.selectRecent === null ? undefined : database.prepare(kind.selectRecent);
		this.sameBodyStmt = kind.selectSameBody === null ? undefined : database.prepare(kind.selectSameBody);
		this.ftsOrphans = database.prepare(kind.selectFtsOrphans);
		this.ftsDropOne = database.prepare(kind.deleteFtsRow);
		this.activeRows = database.prepare(kind.selectActiveRows);
		this.quarantineOne = database.prepare(kind.updateQuarantine);
		this.insertOne = database.prepare(kind.insertSql);
		this.updateOne = database.prepare(kind.updateSql);
		this.deleteOne = database.prepare(kind.deleteSql);
		this.ftsDrop = database.prepare(kind.ftsDropSql);
		this.ftsInsert = database.prepare(kind.ftsInsertSql);
		this.usageGet = database.prepare(kind.usageGetSql);
		this.usageUpsert = database.prepare(kind.usageUpsertSql);
	}

	/** One row by primary key, undefined when absent. */
	getRow(workspaceId: string, id: string): Row | undefined {
		return this.byId.get(workspaceId, id) as unknown as Row | undefined;
	}

	/** Active rows in injection order. */
	listRows(workspaceId: string): Row[] {
		return this.active.all(workspaceId) as unknown as Row[];
	}

	/** Every non-archived row in injection order (the card's projection). */
	listVisibleRows(workspaceId: string): Row[] {
		return this.visible.all(workspaceId) as unknown as Row[];
	}

	/**
	 * Keyword search, workspace-scoped, in three passes: an AND over the query's
	 * token groups (trigram FTS first, LIKE underneath), then — because a
	 * natural-language question is not a keyword list — an OR over the same
	 * alternatives. A question like "什么时候可以 publish" shares no trigram run
	 * with "发版前必须 CI 全绿"; the strict pass returns nothing and the OR pass
	 * recovers it on "publish" (ADR `2026-10-18-absorb-memory-plugin-strengths`).
	 */
	searchRows(workspaceId: string, query: string, limit: number): Row[] {
		const tokens = queryTokens(query);
		if (tokens.length === 0) {
			return [];
		}
		const groups = tokens.map(searchAlternatives);
		const strict = this.matchSearch(workspaceId, groups, "AND", limit);
		if (strict.length > 0 || groups.length === 1) {
			return strict;
		}
		return this.matchSearch(workspaceId, groups.flat().map((token) => [token]), "OR", limit);
	}

	/**
	 * One search pass over the query's alternatives.
	 * @param workspaceId - The partition.
	 * @param groups - Alternatives per token; joined by {@link joiner}.
	 * @param joiner - `AND` (every group must match) or `OR` (any alternative).
	 * @param limit - Row cap.
	 * @returns Matching rows in the kind's order.
	 */
	private matchSearch(
		workspaceId: string,
		groups: readonly (readonly string[])[],
		joiner: "AND" | "OR",
		limit: number,
	): Row[] {
		if (groups.every((group) => group.every((token) => token.length >= 3))) {
			const expression = groups
				.map((group) => (group.length === 1 ? ftsPhrase(group[0] as string) : `(${group.map(ftsPhrase).join(" OR ")})`))
				.join(` ${joiner} `);
			const hits = this.fts.all(expression, workspaceId, limit) as unknown as Row[];
			if (hits.length > 0) {
				return hits;
			}
		}
		return this.likeSearch(workspaceId, groups, joiner, limit);
	}

	private likeSearch(
		workspaceId: string,
		groups: readonly (readonly string[])[],
		joiner: "AND" | "OR",
		limit: number,
	): Row[] {
		const key = `${joiner}:${groups.map((group) => group.length).join(",")}`;
		let stmt = this.likeStmts.get(key);
		if (stmt === undefined) {
			const columns = this.kind.likeColumns;
			const clause = groups
				.map((group) =>
					`(${group.map(() => `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`).join(" OR ")})`,
				)
				.join(` ${joiner} `);
			stmt = this.database.prepare(
				`SELECT * FROM ${this.kind.table} WHERE workspace_id = ? AND status = 'active' AND ${clause} ${this.kind.order} LIMIT ?`,
			);
			this.likeStmts.set(key, stmt);
		}
		const patterns = groups.flatMap((group) =>
			group.flatMap((token) => {
				const pattern = likePattern(token);
				return this.kind.likeColumns.map(() => pattern);
			}),
		);
		return stmt.all(workspaceId, ...patterns, limit) as unknown as Row[];
	}

	/** Insert one row; values follow the kind's insertSql placeholders. */
	insertRow(values: readonly SqlValue[]): void {
		this.insertOne.run(...values);
	}

	/** Update one row; values follow the kind's updateSql placeholders. */
	updateRow(values: readonly SqlValue[]): void {
		this.updateOne.run(...values);
	}

	/** Delete one row by primary key. */
	deleteRow(workspaceId: string, id: string): void {
		this.deleteOne.run(workspaceId, id);
	}

	/**
	 * Soft-isolate one row. Returns true when a row changed; throws on
	 * database errors so the caller keeps its degrade discipline.
	 */
	quarantineRow(workspaceId: string, id: string): boolean {
		const result = this.quarantineOne.run(workspaceId, id) as { changes?: unknown };
		return Number(result.changes) > 0;
	}

	/** Re-sync the FTS row for one id from its table row (delete + insert). */
	syncFts(workspaceId: string, id: string): void {
		this.ftsDrop.run(workspaceId, id);
		this.ftsInsert.run(workspaceId, id);
	}

	/** FTS rowids with no matching table row. */
	ftsOrphanIds(): number[] {
		return (this.ftsOrphans.all() as { rid: number }[]).map((row) => row.rid);
	}

	/** Drop one orphan FTS row by rowid. */
	dropFtsRow(rid: number): void {
		this.ftsDropOne.run(rid);
	}

	/** Every active row (the patrol's secret screen). */
	activeRowList(): Row[] {
		return this.activeRows.all() as unknown as Row[];
	}

	/** Partitions holding active rows with their counts and recency. */
	workspaceList(): { workspace_id: string; n: number; u: string }[] {
		return this.workspaces.all() as { workspace_id: string; n: number; u: string }[];
	}

	/** The partition's newest instant, for the most-recently-active race. */
	recentInstant(): { workspace_id?: unknown; ts?: unknown } | undefined {
		return this.recentStmt?.get() as unknown as { workspace_id?: unknown; ts?: unknown } | undefined;
	}

	/**
	 * Owner id of an identical active body, for the same-body dedupe gate.
	 * Undefined both when unconfigured and when no duplicate exists.
	 */
	findBodyOwner(workspaceId: string, body: string): string | undefined {
		const row = this.sameBodyStmt?.get(workspaceId, body) as unknown as { id: string } | undefined;
		return row?.id;
	}

	/**
	 * Archive one row in place (status + timestamp). Derived from the table
	 * name — archiving is the same shape for every kind, so it is not a
	 * descriptor field.
	 */
	archiveRow(workspaceId: string, id: string, ts: string): void {
		let stmt = this.archiveStmt;
		if (stmt === undefined) {
			stmt = this.database.prepare(
				`UPDATE ${this.kind.table} SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?`,
			);
			this.archiveStmt = stmt;
		}
		stmt.run(ts, workspaceId, id);
	}

	/**
	 * Archived rows of one partition, newest first, capped for viewers.
	 * @param workspaceId - The partition.
	 * @param limit - Row cap.
	 * @returns The archived rows.
	 */
	listArchivedRows(workspaceId: string, limit: number): Row[] {
		return this.database.prepare(
			`SELECT * FROM ${this.kind.table} WHERE workspace_id = ? AND status = 'archived' ORDER BY updated_at DESC LIMIT ?`,
		).all(workspaceId, limit) as unknown as Row[];
	}

	/** Aggregate usage for one item, undefined when never consumed. */
	getUsage(workspaceId: string, keys: readonly string[]): { use_count: number; last_used_at: string | null } | undefined {
		return this.usageGet.get(workspaceId, ...keys) as unknown as
			| { use_count: number; last_used_at: string | null }
			| undefined;
	}

	/** Bump one item's usage counter; throws so the caller keeps its discipline. */
	recordUsage(workspaceId: string, keys: readonly string[], ts: string): void {
		this.usageUpsert.run(workspaceId, ...keys, ts);
	}
}
