-- dsh-continual-evolve schema snapshot (G6)
-- source: src/data/schema.ts GUARDED_TABLES (+ review-accounts / store-types / item-events single homes)
-- update: tsx scripts/verify-schema-snapshot.ts --update

-- table: memories
-- columns: workspace_id, id, type, title, description, body, status, source_session, source_seqs, source_run, corrects, scope, probation_until, origin_workspace, not_when, archive_reason, merged_into, created_at, updated_at
-- check archive_reason IN ('','promoted-source','review-archive','demoted-source','merged-duplicate')
CREATE TABLE IF NOT EXISTS memories (
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
  corrects TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  probation_until TEXT,
  origin_workspace TEXT,
  not_when TEXT NOT NULL DEFAULT '',
  archive_reason TEXT NOT NULL DEFAULT '' CHECK (archive_reason IN ('','promoted-source','review-archive','demoted-source','merged-duplicate')),
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;

-- table: extraction_log
-- columns: run_id, ts, session_id, workspace_id, trigger, decision, skip_reason, status, duration_ms, model, usage, cheap_usage, cheap_error, classify_usage, classify_error, prompt_json, dropped_warnings, files, occurrences
-- check trigger IN ('turn-debounce','compaction','close-drain','explicit','import','item-review')
CREATE TABLE IF NOT EXISTS extraction_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT CHECK (trigger IN ('turn-debounce','compaction','close-drain','explicit','import','item-review')),
  decision TEXT, skip_reason TEXT,
  status TEXT, duration_ms INTEGER, model TEXT, usage TEXT,
  cheap_usage TEXT, cheap_error TEXT,
  classify_usage TEXT, classify_error TEXT, prompt_json TEXT, dropped_warnings TEXT,
  files TEXT, occurrences INTEGER NOT NULL DEFAULT 1
);

-- table: item_events
-- columns: ts, workspace_id, item_kind, item_id, event, source_id, reason
-- check event IN ('similar','corrects','correction')
CREATE TABLE IF NOT EXISTS item_events (
  ts TEXT NOT NULL, workspace_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('memory','skill')),
  item_id TEXT NOT NULL,
  event TEXT CHECK (event IN ('similar','corrects','correction')),
  source_id TEXT, reason TEXT
) STRICT;

-- table: review_log
-- columns: run_id, ts, workspace_id, item_kind, item_id, verdict, reason, proposed, model, cheap_usage, evolve_usage, applied, evolve_count
-- check verdict IN ('keep','rewrite','quarantine','skip','archive','promote','demote','export-suggestion')
CREATE TABLE IF NOT EXISTS review_log (
  run_id TEXT, ts TEXT NOT NULL, workspace_id TEXT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('memory','skill')),
  item_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep','rewrite','quarantine','skip','archive','promote','demote','export-suggestion')),
  reason TEXT,
  proposed TEXT,
  model TEXT,
  cheap_usage TEXT, evolve_usage TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  evolve_count INTEGER NOT NULL DEFAULT 0
);
