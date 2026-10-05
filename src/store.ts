/**
 * The central SQLite memory store: one database file
 * (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path) holding
 * every memory record, its FTS index, the extraction ledger, and per-session
 * extraction cursors. The plugin's code is the literal sole writer — models
 * propose, `applyProposals` gates and lands. See ADR
 * `2026-10-06-sqlite-single-store`.
 *
 * Requires `node:sqlite` (Node ≥ 22.5; the desktop host's EnsureNode runtime
 * guarantees v26). Unavailability is a typed error the entry point degrades
 * on — injection and tooling switch off, the host keeps running.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryProposal } from "./memory-rules.js";
import { secretLeakReason } from "./memory-rules.js";
import { applyProposals, type ProposalContext, type ProposalOutcome } from "./store-apply.js";

export type { MemoryProposal, ProposalContext, ProposalOutcome };

/** Thrown when the runtime lacks `node:sqlite` — the degrade signal. */
export class StoreUnavailableError extends Error {}

/** State-table keys owned by the store (partitioned per workspace, `""` = global). */
export const CURSOR_KEY_PREFIX = "seq:";
export const PATROL_STATE_KEY = "patrol:last";
export const MD_IMPORT_STATE_KEY = "md-imported";
/** Global partition id for workspace-independent state rows. */
export const GLOBAL_WORKSPACE = "";
/** Preview size cap for the card's content endpoint (ZCode's viewer uses 5 MiB). */
export const MEMORY_FILE_PREVIEW_LIMIT = 5 * 1024 * 1024;

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS memories (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','reference')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT,
  source_seqs TEXT,
  source_run TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mem_ws_status ON memories(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_ws_updated ON memories(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- FTS rows are synced in code by applyProposals (plain DELETE + INSERT), not
-- by triggers: node:sqlite rejects the FTS5 'delete'-command INSERT that
-- AFTER DELETE/UPDATE triggers would need (SQL logic error, verified on
-- SQLite 3.53.4). The sole-writer design makes code-side sync reliable;
-- patrol() reconciles any residue.
CREATE TABLE IF NOT EXISTS extraction_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT CHECK (trigger IN ('turn-debounce','compaction','close-drain','explicit','import')),
  decision TEXT, skip_reason TEXT,
  status TEXT, duration_ms INTEGER, model TEXT, usage TEXT,
  files TEXT
);
CREATE TABLE IF NOT EXISTS state (
  workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
) STRICT;
`;

/** One stored memory record (snake_case columns camelCased). */
export interface MemoryRecord {
	workspaceId: string;
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the fact came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The extraction run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	createdAt: string;
	updatedAt: string;
}

/** One ledger row (audit + rollback via embedded before/after snapshots). */
export interface LedgerEntry {
	runId?: string | undefined;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	trigger: "turn-debounce" | "compaction" | "close-drain" | "explicit" | "import";
	decision?: string | undefined;
	skipReason?: string | undefined;
	status?: string | undefined;
	durationMs?: number | undefined;
	model?: string | undefined;
	usage?: unknown;
	/** Applied/attempted mutations: `{id, action, before?, after?, sourceSeqs}`. */
	files?: unknown;
}

/** Workspace rows the card's selector lists. */
export interface WorkspaceSummary {
	workspaceId: string;
	activeCount: number;
	updatedAt: string;
}

/** What a patrol pass found and did. */
export interface PatrolResult {
	ts: string;
	/** Orphan FTS rows (no matching memory) removed. */
	orphanFtsRows: number;
	/** Records quarantined by the secret screen, with the redacted reasons. */
	quarantined: { workspaceId: string; id: string; reason: string }[];
}

/** The store surface every consumer (tool, extraction, card, injection) uses. */
export interface MemoryStore {
	readonly path: string;
	get(workspaceId: string, id: string): MemoryRecord | undefined;
	/** Active records, injection order: feedback > user > reference, then newest. */
	list(workspaceId: string): MemoryRecord[];
	/** Every non-archived record regardless of status (the card's projection). */
	listAll(workspaceId: string): MemoryRecord[];
	/** FTS search (trigram, workspace-scoped); <3-char queries fall back to LIKE. */
	search(workspaceId: string, query: string, limit?: number): MemoryRecord[];
	/** The sole write gate: validate all proposals, apply atomically, ledger. */
	applyProposals(ctx: ProposalContext, proposals: readonly MemoryProposal[]): ProposalOutcome[];
	/** Ledger a run that produced no mutations (skips must be auditable too). */
	logSkipped(entry: LedgerEntry): void;
	cursor(workspaceId: string, sessionId: string): number | undefined;
	setCursor(workspaceId: string, sessionId: string, seq: number): void;
	state(workspaceId: string, key: string): string | undefined;
	setState(workspaceId: string, key: string, value: string): void;
	listWorkspaces(): WorkspaceSummary[];
	/** Hygiene pass: orphan FTS cleanup + secret quarantine. */
	patrol(): PatrolResult;
	/** Ledger rows older than the cutoff, removed (the one unbounded table). */
	pruneLedger(beforeIso: string): number;
	close(): void;
}

/** Default database location: `$DSH_HOME/evolve/memory.db`, else `~/.dsh/…`. */
export function defaultStorePath(): string {
	const home = process.env.DSH_HOME?.trim();
	return resolve(home && home.length > 0 ? home : join(homedir(), ".dsh"), "evolve", "memory.db");
}

interface MemoryRow {
	workspace_id: string;
	id: string;
	type: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	created_at: string;
	updated_at: string;
}

function recordOf(row: MemoryRow): MemoryRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		type: row.type as MemoryRecord["type"],
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as MemoryRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const LIST_ORDER =
	"ORDER BY CASE type WHEN 'feedback' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, updated_at DESC";

/** Quote a user query as an FTS5 phrase (trigram needs ≥3 chars to match). */
function ftsPhrase(query: string): string {
	return `"${query.replaceAll('"', '""')}"`;
}

/** Open (creating on first use) the central store. */
export async function openMemoryStore(explicitPath?: string): Promise<MemoryStore> {
	const path = explicitPath === undefined ? defaultStorePath() : resolve(explicitPath);
	let database: DatabaseSync;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		// The parent directory must exist before SQLite opens the file — a
		// fresh `~/.dsh` has no `evolve/` yet.
		mkdirSync(dirname(path), { recursive: true });
		database = new DatabaseSync(path);
	} catch (error) {
		throw new StoreUnavailableError(
			`node:sqlite unavailable (Node ≥ 22.5 required) — memory store disabled: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	database.exec(DDL);

	const stmts = {
		get: database.prepare("SELECT * FROM memories WHERE workspace_id = ? AND id = ?"),
		list: database.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND status = 'active' ${LIST_ORDER}`),
		listAll: database.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND status != 'archived' ${LIST_ORDER}`),
		fts: database.prepare(
			`SELECT m.* FROM memories m WHERE (m.workspace_id, m.id) IN (
				 SELECT workspace_id, id FROM memories_fts WHERE memories_fts MATCH ? AND workspace_id = ?
				) AND m.status = 'active' ${LIST_ORDER} LIMIT ?`,
		),
		like: database.prepare(
			`SELECT * FROM memories WHERE workspace_id = ? AND status = 'active'
			 AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ${LIST_ORDER} LIMIT ?`,
		),
		stateGet: database.prepare("SELECT value FROM state WHERE workspace_id = ? AND key = ?"),
		stateSet: database.prepare(
			"INSERT INTO state (workspace_id, key, value) VALUES (?, ?, ?) " +
				"ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value",
		),
		cursorGet: database.prepare(
			"SELECT CAST(value AS INTEGER) AS seq FROM state WHERE workspace_id = ? AND key = ?",
		),
		workspaces: database.prepare(
			"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM memories WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
		),
		ledger: database.prepare(
			"INSERT INTO extraction_log (run_id, ts, session_id, workspace_id, trigger, decision, skip_reason, status, duration_ms, model, usage, files) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		prune: database.prepare("DELETE FROM extraction_log WHERE ts < ?"),
		ftsOrphans: database.prepare(
			"SELECT f.rowid AS rid FROM memories_fts f LEFT JOIN memories m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
		),
		ftsDrop: database.prepare("DELETE FROM memories_fts WHERE rowid = ?"),
		activeRows: database.prepare("SELECT * FROM memories WHERE status = 'active'"),
		quarantine: database.prepare("UPDATE memories SET status = 'quarantined' WHERE workspace_id = ? AND id = ?"),
	};

	const store: MemoryStore = {
		path,
		get(workspaceId, id) {
			const row = stmts.get.get(workspaceId, id) as MemoryRow | undefined;
			return row === undefined ? undefined : recordOf(row);
		},
		list(workspaceId) {
			return (stmts.list.all(workspaceId) as unknown as MemoryRow[]).map(recordOf);
		},
		listAll(workspaceId) {
			return (stmts.listAll.all(workspaceId) as unknown as MemoryRow[]).map(recordOf);
		},
		search(workspaceId, query, limit = 20) {
			const trimmed = query.trim();
			if (trimmed.length < 3) {
				const like = `%${trimmed.replaceAll(/[\\%_]/g, "\\$&")}%`;
				return (stmts.like.all(workspaceId, like, like, like, limit) as unknown as MemoryRow[]).map(recordOf);
			}
			return (stmts.fts.all(ftsPhrase(trimmed), workspaceId, limit) as unknown as MemoryRow[]).map(recordOf);
		},
		applyProposals(ctx, proposals) {
			return applyProposals({ database, now: () => new Date().toISOString() }, ctx, proposals).outcomes;
		},
		logSkipped(entry) {
			writeLedger(stmts.ledger, entry);
		},
		cursor(workspaceId, sessionId) {
			const row = stmts.cursorGet.get(workspaceId, CURSOR_KEY_PREFIX + sessionId) as
				| { seq: number | null }
				| undefined;
			return row?.seq === null || row === undefined ? undefined : row.seq;
		},
		setCursor(workspaceId, sessionId, seq) {
			stmts.stateSet.run(workspaceId, CURSOR_KEY_PREFIX + sessionId, String(seq));
		},
		state(workspaceId, key) {
			const row = stmts.stateGet.get(workspaceId, key) as { value: string } | undefined;
			return row?.value;
		},
		setState(workspaceId, key, value) {
			stmts.stateSet.run(workspaceId, key, value);
		},
		listWorkspaces() {
			return (stmts.workspaces.all() as { workspace_id: string; n: number; u: string }[]).map((row) => ({
				workspaceId: row.workspace_id,
				activeCount: row.n,
				updatedAt: row.u,
			}));
		},
		patrol() {
			const result: PatrolResult = { ts: new Date().toISOString(), orphanFtsRows: 0, quarantined: [] };
			for (const row of stmts.ftsOrphans.all() as { rid: number }[]) {
				stmts.ftsDrop.run(row.rid);
				result.orphanFtsRows += 1;
			}
			for (const row of stmts.activeRows.all() as unknown as MemoryRow[]) {
				const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
				if (reason !== undefined) {
					stmts.quarantine.run(row.workspace_id, row.id);
					result.quarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
				}
			}
			stmts.stateSet.run(GLOBAL_WORKSPACE, PATROL_STATE_KEY, JSON.stringify(result));
			return result;
		},
		pruneLedger(beforeIso) {
			return Number(stmts.prune.run(beforeIso).changes);
		},
		close() {
			database.close();
		},
	};
	return store;
}

/** JSON-encode the optional ledger fields and insert the row (never throws past a warn). */
function writeLedger(stmt: { run(...args: unknown[]): unknown }, entry: LedgerEntry): void {
	stmt.run(
		entry.runId ?? null,
		new Date().toISOString(),
		entry.sessionId ?? null,
		entry.workspaceId ?? null,
		entry.trigger,
		entry.decision ?? null,
		entry.skipReason ?? null,
		entry.status ?? null,
		entry.durationMs ?? null,
		entry.model ?? null,
		entry.usage === undefined ? null : JSON.stringify(entry.usage),
		entry.files === undefined ? null : JSON.stringify(entry.files),
	);
}
