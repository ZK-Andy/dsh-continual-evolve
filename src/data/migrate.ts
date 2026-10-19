/**
 * Schema and migrations for the central store: the full DDL for fresh files,
 * one idempotent ALTER per column added later, and the shape guard that
 * rebuilds a table whose `CHECK` whitelist drifted. The plugin is the sole
 * writer of an existing user database, so each change needs exactly one
 * migration — a column goes here, a value set goes in `./schema.js`.
 */
import type { DatabaseSync } from "node:sqlite";
import { LEDGER_OCCURRENCES } from "../store-types.js";
import { backfillArchiveReasons } from "./archive-backfill.js";
import { evalCasesDdl } from "./eval-cases.js";
import { extractionLogDdl, itemEventsDdl, memoriesDdl, rebuildDriftedTables, reviewLogDdl } from "./schema.js";
import { INJECTION_LOG_DDL } from "./injection-log.js";

const SCHEMA_DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;${memoriesDdl("memories")};
${evalCasesDdl("eval_cases")};
CREATE INDEX IF NOT EXISTS idx_mem_ws_status ON memories(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_ws_updated ON memories(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- FTS rows are synced in code by applyProposals (plain DELETE + INSERT), not
-- by triggers: node:sqlite rejects the FTS5 'delete'-command INSERT that
-- AFTER DELETE/UPDATE triggers would need (SQL logic error, verified on
-- SQLite 3.53.4). The sole-writer design makes code-side sync reliable;
-- patrol() reconciles any residue.
${extractionLogDdl("extraction_log")};
${INJECTION_LOG_DDL}
CREATE TABLE IF NOT EXISTS state (
  workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE IF NOT EXISTS skills (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_skill_ws_status ON skills(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_ws_updated ON skills(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- Like memories_fts, synced in code by the skill apply path (plain DELETE +
-- INSERT), never by triggers, for the same node:sqlite FTS5 reason.
CREATE TABLE IF NOT EXISTS skill_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT, decision TEXT, status TEXT, files TEXT, warnings TEXT
);
-- Skill usage counters (V2 usage loop): one aggregate row per skill, never a
-- per-hit ledger, so the table cannot grow without bound and needs no prune.
CREATE TABLE IF NOT EXISTS skill_usage (
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','global')),
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, skill_id, scope)
) STRICT;
-- Memory usage counters (content-quality loop): one aggregate row per memory,
-- the same presence-heartbeat discipline as skill_usage — a body served by id
-- counts, search/list hits stay uncounted.
CREATE TABLE IF NOT EXISTS memory_usage (
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, memory_id)
) STRICT;
-- Per-item content-review verdicts (the item-review trigger's account):
-- one row per reviewed item per run, with the model it ran on so a failure
-- rate can be attributed instead of guessed at. Pruned with the ledgers.
${reviewLogDdl("review_log")};
-- The review queue's event tier (ADR 2026-10-17-review-and-tiering-batch-rollout):
-- one row per linkage that puts an item back in front of review. A log, not a
-- consumed queue — the row is audit, and "newer than the item's latest complete
-- verdict" is the pending test. Pruned with the ledgers.
${itemEventsDdl("item_events")};
CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events(workspace_id, item_kind, item_id, ts);
CREATE INDEX IF NOT EXISTS idx_item_events_ts ON item_events(ts);
-- One rollup row per UTC day: the hard-cap account (budget vs reviewed vs
-- backlog vs dropped) plus the token account split by cheap/evolve purpose.
-- requeued is the total; the three source columns say why an item came back
-- (event linkage / calendar clock / stale sampling) and always sum to it.
CREATE TABLE IF NOT EXISTS review_daily (
  day TEXT NOT NULL PRIMARY KEY,
  budget INTEGER NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  requeued INTEGER NOT NULL DEFAULT 0,
  requeued_link INTEGER NOT NULL DEFAULT 0,
  requeued_sampled INTEGER NOT NULL DEFAULT 0,
  requeued_clock INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  cheap_token INTEGER NOT NULL DEFAULT 0,
  evolve_token INTEGER NOT NULL DEFAULT 0,
  backlog INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  skip_top TEXT,
  skip_counts TEXT
) STRICT;
-- The plugin's own log. A stock host attaches no exporter to its logger, so a
-- ctx.logger call leaves no trace anywhere (docs/FAQ.md #4) — diagnostics that
-- have no domain ledger row of their own land here instead. Pruned with the
-- ledgers; the event column is a stable slug, so runs can be counted and grepped.
CREATE TABLE IF NOT EXISTS plugin_log (
  ts TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  workspace_id TEXT,
  session_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plugin_log_ts ON plugin_log(ts);
-- Prompt supplements (the third managed kind): workspace-scoped reusable
-- prompt text, skill-shaped rows without scope or taxonomy. Same FTS and
-- ledger discipline as skills; writes ledger to prompt_log, usage to
-- prompt_usage. See the P5 trial (docs/plans/2026-10-15-layered-generic-repository.md).
CREATE TABLE IF NOT EXISTS prompts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_prompt_ws_status ON prompts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_prompt_ws_updated ON prompts(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- Like memories_fts, synced in code by the prompt apply path (plain DELETE +
-- INSERT), never by triggers, for the same node:sqlite FTS5 reason.
CREATE TABLE IF NOT EXISTS prompt_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT, decision TEXT, status TEXT, files TEXT
);
-- Prompt usage counters: one aggregate row per prompt, the same
-- presence-heartbeat discipline as memory_usage — a body served by id
-- counts, search/list hits stay uncounted.
CREATE TABLE IF NOT EXISTS prompt_usage (
  workspace_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, prompt_id)
) STRICT;
`;

/**
 * Apply the full schema, then every later column migration, then the shape
 * guard — a store that predates a `CHECK` value-set change is rebuilt here,
 * so the value set the code writes rows with is the one every store runs on.
 * @param database - The open database handle.
 */
export function migrateDatabase(database: DatabaseSync): void {
	database.exec(SCHEMA_DDL);
	ensureLedgerOccurrences(database);
	ensureMemoriesCorrects(database);
	ensureExtractionCheapUsage(database);
	ensureExtractionCheapError(database);
	ensureExtractionClassifyUsage(database);
	ensureExtractionClassifyError(database);
	ensureExtractionPromptJson(database);
	ensureExtractionDroppedWarnings(database);
	ensureReviewProposed(database);
	ensureReviewModel(database);
	ensureReviewDailySources(database);
	ensureMemoriesScope(database);
	ensureMemoriesProbation(database);
	ensureMemoriesOrigin(database);
	ensureMemoriesNotWhen(database);
	ensureMemoriesArchiveColumns(database);
	// Columns first, then shape: the rebuild copies the guard's column list,
	// and the ALTERs above are what make an old table carry all of it.
	rebuildDriftedTables(database);
	// Data second: project reasons for rows archived before P4 on every open,
	// so no user ever runs the backfill script by hand. Idempotent (only
	// `''` rows) and ledger-local, safe to re-run on each mount.
	backfillArchiveReasons(database);
}

/**
 * Add the ledger's `occurrences` column to a store created before coalescing
 * existed. The DDL only covers fresh files, and the plugin is the sole writer
 * of an existing user database — the one migration the ledger needs.
 */
function ensureLedgerOccurrences(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === LEDGER_OCCURRENCES)) {
		return;
	}
	database.exec(`ALTER TABLE extraction_log ADD COLUMN ${LEDGER_OCCURRENCES} INTEGER NOT NULL DEFAULT 1`);
}

/**
 * Add the memories `corrects` link column to a store created before the
 * correction-linking field existed. Same single-migration discipline as the
 * ledger occurrences column above.
 */
function ensureMemoriesCorrects(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "corrects")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN corrects TEXT");
}

/**
 * Add the extraction ledger `cheap_usage` column to a store created before
 * the cheap pre-gate existed. Same single-migration discipline as the
 * columns above.
 */
function ensureExtractionCheapUsage(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "cheap_usage")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN cheap_usage TEXT");
}

/**
 * Add the extraction ledger `cheap_error` column to a store created before
 * the failed-gate head was ledgered. Separate from the `cheap_usage`
 * migration above so a store that already carries that column still gains
 * this one. Same single-migration discipline as the columns above.
 */
function ensureExtractionCheapError(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "cheap_error")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN cheap_error TEXT");
}

/** P2: `classify_usage` for stores predating the classification pass. */
function ensureExtractionClassifyUsage(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "classify_usage")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN classify_usage TEXT");
}

/** P2: `classify_error` for stores predating the classification pass. */
function ensureExtractionClassifyError(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "classify_error")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN classify_error TEXT");
}

/** P2 audit (D8): `prompt_json` for stores predating replayable prompts. */
function ensureExtractionPromptJson(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "prompt_json")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN prompt_json TEXT");
}

/** P2: `dropped_warnings` for stores predating per-item drop warnings. */
function ensureExtractionDroppedWarnings(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "dropped_warnings")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN dropped_warnings TEXT");
}

/**
 * Add the review ledger `proposed` column to a store created before trial
 * mode started keeping the rewrite it declined to land. Same single-migration
 * discipline as the columns above.
 */
function ensureReviewProposed(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('review_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "proposed")) {
		return;
	}
	database.exec("ALTER TABLE review_log ADD COLUMN proposed TEXT");
}

/**
 * Add the review ledger `model` column to a store created before verdict rows
 * recorded the model they ran on. Same single-migration discipline as the
 * columns above.
 */
function ensureReviewModel(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('review_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "model")) {
		return;
	}
	database.exec("ALTER TABLE review_log ADD COLUMN model TEXT");
}

/**
 * Add the memories `scope` marker to a store created before promotion
 * candidates existed. Existing rows are `project`: nothing was ever marked
 * `person` before this column did.
 */
function ensureMemoriesScope(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "scope")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'");
}

/**
 * Add the memories `probation_until` column to a store created before the
 * global probation window existed. Nullable: only rows that were promoted
 * carry it.
 */
function ensureMemoriesProbation(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "probation_until")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN probation_until TEXT");
}

/**
 * Add the memories `origin_workspace` column to a store created before
 * promotion existed. Only a promoted (global) row carries it: demotion needs
 * to know where the row came from without re-judging anything.
 */
function ensureMemoriesOrigin(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "origin_workspace")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN origin_workspace TEXT");
}

/**
 * Add the memories `not_when` column: the per-memory caveat ("this rule does
 * not hold when …"), rendered with the hook and never used for retrieval
 * filtering (ADR `2026-10-18-absorb-memory-plugin-strengths`). A store created
 * before the column reads it as "no caveat recorded", never as null.
 */
function ensureMemoriesNotWhen(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "not_when")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN not_when TEXT NOT NULL DEFAULT ''");
}

/**
 * Add the P4 archive columns to a store created before them: `archive_reason`
 * (existing archived rows gain their reason from the ledgers by the automatic
 * backfill at the end of `migrateDatabase`; unprovable rows stay `''`) and
 * `merged_into` (only `merged-duplicate` rows carry it). One function for one
 * batch, the same discipline as the rollup's per-source counters below.
 */
function ensureMemoriesArchiveColumns(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	const present = new Set(columns.map((column) => column.name));
	if (!present.has("archive_reason")) {
		database.exec("ALTER TABLE memories ADD COLUMN archive_reason TEXT NOT NULL DEFAULT ''");
	}
	if (!present.has("merged_into")) {
		database.exec("ALTER TABLE memories ADD COLUMN merged_into TEXT");
	}
}

/**
 * Add the rollup's per-source requeue counters to a store created before the
 * queue stopped being one undifferentiated tier. `review_daily` is STRICT, so
 * each column arrives with the default the fresh DDL declares — an old row
 * reads as "no source recorded", never as null. Same single-migration
 * discipline as the columns above.
 */
function ensureReviewDailySources(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('review_daily')").all() as { name: string }[];
	const present = new Set(columns.map((column) => column.name));
	for (const column of ["requeued_link", "requeued_sampled", "requeued_clock"]) {
		if (!present.has(column)) {
			database.exec(`ALTER TABLE review_daily ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
		}
	}
}
