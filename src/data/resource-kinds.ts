/**
 * The per-kind SQL bundles: everything that differs between two managed
 * objects, as strings. Execution lives in {@link Repository}; the store
 * assembly instantiates one repository per kind from these descriptors.
 * Table names come from code constants, never user input, so interpolating
 * them is safe.
 */
import type { ResourceKind } from "./repository.js";

// `id` is the tiebreak on purpose: the injected index must be byte-stable for a
// given store, and SQLite leaves equal-key rows unordered (ADR
// `2026-10-18-absorb-memory-plugin-strengths`).
const MEMORIES_ORDER =
	"ORDER BY CASE type WHEN 'feedback' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, updated_at DESC, id ASC";

/**
 * The memories kind descriptor: every memories SQL string in one place.
 * Execution lives in {@link Repository}.
 */
export const MEMORIES: ResourceKind = {
	table: "memories",
	order: MEMORIES_ORDER,
	likeColumns: ["title", "description", "body"],
	selectById: "SELECT * FROM memories WHERE workspace_id = ? AND id = ?",
	selectActive: `SELECT * FROM memories WHERE workspace_id = ? AND status = 'active' ${MEMORIES_ORDER}`,
	selectVisible: `SELECT * FROM memories WHERE workspace_id = ? AND status != 'archived' ${MEMORIES_ORDER}`,
	selectFts:
		"SELECT m.* FROM memories m WHERE (m.workspace_id, m.id) IN (" +
		"SELECT workspace_id, id FROM memories_fts WHERE memories_fts MATCH ? AND workspace_id = ?) " +
		`AND m.status = 'active' ${MEMORIES_ORDER} LIMIT ?`,
	selectWorkspaces:
		"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM memories WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
	selectRecent:
		"SELECT workspace_id, MAX(updated_at) AS ts FROM memories " +
		"WHERE status = 'active' AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
	selectSameBody: null,
	selectFtsOrphans:
		"SELECT f.rowid AS rid FROM memories_fts f LEFT JOIN memories m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
	deleteFtsRow: "DELETE FROM memories_fts WHERE rowid = ?",
	selectActiveRows: "SELECT * FROM memories WHERE status = 'active'",
	updateQuarantine: "UPDATE memories SET status = 'quarantined' WHERE workspace_id = ? AND id = ?",
	insertSql:
		"INSERT INTO memories (workspace_id, id, type, title, description, body, scope, status, source_session, source_seqs, source_run, corrects, not_when, created_at, updated_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)",
	updateSql:
		"UPDATE memories SET type = ?, title = ?, description = ?, body = ?, scope = ?, corrects = COALESCE(?, corrects), not_when = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
	deleteSql: "DELETE FROM memories WHERE workspace_id = ? AND id = ?",
	ftsDropSql: "DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories_fts WHERE workspace_id = ? AND id = ?)",
	ftsInsertSql:
		"INSERT INTO memories_fts (workspace_id, id, title, description, body) " +
		"SELECT workspace_id, id, title, description, body FROM memories WHERE workspace_id = ? AND id = ?",
	usageGetSql: "SELECT use_count, last_used_at FROM memory_usage WHERE workspace_id = ? AND memory_id = ?",
	usageUpsertSql:
		"INSERT INTO memory_usage (workspace_id, memory_id, use_count, last_used_at) VALUES (?, ?, 1, ?) " +
		"ON CONFLICT (workspace_id, memory_id) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
};

/**
 * The prompt-supplement kind descriptor: workspace-scoped reusable prompt
 * text, skill-shaped rows without scope or taxonomy. The P5 trial proves a
 * third kind plugs in as one descriptor plus gates — tools, card, patrol,
 * and ledger follow the same generic paths as the first two kinds.
 */
export const PROMPTS: ResourceKind = {
	table: "prompts",
	order: "ORDER BY updated_at DESC",
	likeColumns: ["title", "description", "body"],
	selectById: "SELECT * FROM prompts WHERE workspace_id = ? AND id = ?",
	selectActive: "SELECT * FROM prompts WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC",
	selectVisible: "SELECT * FROM prompts WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC",
	selectFts:
		"SELECT s.* FROM prompts s WHERE (s.workspace_id, s.id) IN (" +
		"SELECT workspace_id, id FROM prompts_fts WHERE prompts_fts MATCH ? AND workspace_id = ?) " +
		"AND s.status = 'active' ORDER BY updated_at DESC LIMIT ?",
	selectWorkspaces:
		"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM prompts WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
	selectRecent:
		"SELECT workspace_id, MAX(updated_at) AS ts FROM prompts " +
		"WHERE status = 'active' AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
	selectSameBody: "SELECT id FROM prompts WHERE workspace_id = ? AND status = 'active' AND body = ? LIMIT 1",
	selectFtsOrphans:
		"SELECT f.rowid AS rid FROM prompts_fts f LEFT JOIN prompts m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
	deleteFtsRow: "DELETE FROM prompts_fts WHERE rowid = ?",
	selectActiveRows: "SELECT * FROM prompts WHERE status = 'active'",
	updateQuarantine: "UPDATE prompts SET status = 'quarantined' WHERE workspace_id = ? AND id = ?",
	insertSql:
		"INSERT INTO prompts (workspace_id, id, title, description, body, status, source_session, source_seqs, source_run, created_at, updated_at) " +
		"VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
	updateSql: "UPDATE prompts SET title = ?, description = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
	deleteSql: "DELETE FROM prompts WHERE workspace_id = ? AND id = ?",
	ftsDropSql: "DELETE FROM prompts_fts WHERE rowid IN (SELECT rowid FROM prompts_fts WHERE workspace_id = ? AND id = ?)",
	ftsInsertSql:
		"INSERT INTO prompts_fts (workspace_id, id, title, description, body) " +
		"SELECT workspace_id, id, title, description, body FROM prompts WHERE workspace_id = ? AND id = ?",
	usageGetSql: "SELECT use_count, last_used_at FROM prompt_usage WHERE workspace_id = ? AND prompt_id = ?",
	usageUpsertSql:
		"INSERT INTO prompt_usage (workspace_id, prompt_id, use_count, last_used_at) VALUES (?, ?, 1, ?) " +
		"ON CONFLICT (workspace_id, prompt_id) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
};
/**
 * The skills kind descriptor: the same SQL the per-skill statements used to
 * carry inline. The skill ledger (`skill_log`) and the file projection stay
 * with the store assembly; only table access is parameterized here.
 */
export const SKILLS: ResourceKind = {
	table: "skills",
	order: "ORDER BY updated_at DESC",
	likeColumns: ["title", "description", "body"],
	selectById: "SELECT * FROM skills WHERE workspace_id = ? AND id = ?",
	selectActive: "SELECT * FROM skills WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC",
	selectVisible: "SELECT * FROM skills WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC",
	selectFts:
		"SELECT s.* FROM skills s WHERE (s.workspace_id, s.id) IN (" +
		"SELECT workspace_id, id FROM skills_fts WHERE skills_fts MATCH ? AND workspace_id = ?) " +
		"AND s.status = 'active' ORDER BY updated_at DESC LIMIT ?",
	selectWorkspaces:
		"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM skills WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
	selectRecent: null,
	selectSameBody: "SELECT id FROM skills WHERE workspace_id = ? AND status = 'active' AND body = ? LIMIT 1",
	selectFtsOrphans:
		"SELECT f.rowid AS rid FROM skills_fts f LEFT JOIN skills m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
	deleteFtsRow: "DELETE FROM skills_fts WHERE rowid = ?",
	selectActiveRows: "SELECT * FROM skills WHERE status = 'active'",
	updateQuarantine: "UPDATE skills SET status = 'quarantined' WHERE workspace_id = ? AND id = ?",
	insertSql:
		"INSERT INTO skills (workspace_id, id, title, description, body, status, source_session, source_seqs, source_run, created_at, updated_at) " +
		"VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
	updateSql: "UPDATE skills SET title = ?, description = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
	deleteSql: "DELETE FROM skills WHERE workspace_id = ? AND id = ?",
	ftsDropSql: "DELETE FROM skills_fts WHERE rowid IN (SELECT rowid FROM skills_fts WHERE workspace_id = ? AND id = ?)",
	ftsInsertSql:
		"INSERT INTO skills_fts (workspace_id, id, title, description, body) " +
		"SELECT workspace_id, id, title, description, body FROM skills WHERE workspace_id = ? AND id = ?",
	usageGetSql: "SELECT use_count, last_used_at FROM skill_usage WHERE workspace_id = ? AND skill_id = ? AND scope = ?",
	usageUpsertSql:
		"INSERT INTO skill_usage (workspace_id, skill_id, scope, use_count, last_used_at) VALUES (?, ?, ?, 1, ?) " +
		"ON CONFLICT (workspace_id, skill_id, scope) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
};
