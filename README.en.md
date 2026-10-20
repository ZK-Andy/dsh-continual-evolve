# dsh-continual-evolve

<p align="center">
  <b>Governed, self-evolving memory for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</b><br>
  The model proposes. The code gates. One database lands.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-continual-evolve"><img src="https://img.shields.io/npm/v/dsh-continual-evolve?color=4D6BFE" alt="npm"></a>
  <a href="https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml"><img src="https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node"></a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome DSH plugin"></a>
  <img src="https://img.shields.io/badge/tests-948%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage_statements-97%25-brightgreen" alt="Coverage statements">
  <img src="https://img.shields.io/badge/coverage_branches-92%25-green" alt="Coverage branches">
  <img src="https://img.shields.io/badge/coverage_functions-99%25-brightgreen" alt="Coverage functions">
</p>

<p align="center"><a href="README.md">中文</a> | English</p>

Every memory and skill lives in one central SQLite database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace). Session start injects its index as a single prompt section, and the plugin's code is the literal **sole writer** — every model proposal passes mechanical gates inside one transaction before it lands. No safety property depends on the model behaving.

## Highlights

- **One store, one writer** — all state in one SQLite file; the plugin is the only code that writes it.
- **Session-start index** — hooks for the current workspace injected as one prompt section, frozen per session, grouped into User Profile / Project Meta / Project Memory / Feedback Memory.
- **A budget that degrades, not drops** — CJK-aware token budget (default 6000) steps from full hooks to id-only lines to an "N more" counter.
- **Two tools** — `evolve_write` lands memories and skills; `evolve_read` serves bodies and searches by keyword (trigram FTS, CJK-aware).
- **Proposal-based extraction** — per-session turn-level automation: no idle timer, a cheap pre-gate, a duplicate/no-change pre-screen, every skip ledgered.
- **Autonomous quality review** — own prompts, budget and ledger; verdicts rewrite / quarantine / archive / advice-only; deletion is never automatic; dry-run by default.
- **Layered memory** — L0 about the person, L1 about a project, L2 never stored; L0 is reachable only through two independent judgements plus a 30-day probation.
- **Observability, not vibes** — build-generation self-check, 7-day injection→read conversion, and an offline recall baseline.
- **Rollback by ledger** — before/after snapshots for every mutation, plus a hygiene patrol for orphan index rows and secret-bearing entries.
- **Plugin-manager cards** — a read-only store projection with search and previews, and the global `review.*` settings card.

## Quick start

```bash
# from npm (activates on install — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# or from source (approve the allowBuilds build step on first GitHub install)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

Restart the profile you actually use (the desktop host or `dsh <profile>`). Requires Node ≥ 22.5 for `node:sqlite`; without it the plugin degrades to a no-op with a console warning.

There are no commands to learn — just talk:

```text
"remember that I review with oxlint, not eslint"   → evolve_write, gated and landed
"save this procedure as a skill"                   → a SKILL.md the skill tool finds after restart
"use it everywhere"                                → the skill moves to the global scope
```

> [!TIP]
> After a restart, open the plugin's page in the plugin manager: the first line compares the running build with the one on disk, and turns red with "restart the host" when they differ. `plugin_log` carries the same reading as a `build-identity` row.

Writes made mid-session become visible in the next session — the injected section is frozen to keep the prompt cache warm.

## How it works

```
  input   ──  "remember …" (evolve_write)  ·  session turns (extraction)
  gates   ──  id shape · type · secret screen · 64KB cap · Why/How contract · one transaction
  store   ──  memory.db, rows partitioned by workspace
  output  ──  index injected next session  ·  review loop (rewrite / quarantine / archive)
```

### Session-start injection

- One system-prompt section (`order 400`): the workspace's index as hooks only — id, title, description clipped to 20 characters, optional `notWhen`; the type is carried by the block's four-group layout rather than a per-line tag (row order within a group stays feedback > user > reference). Plus the store path and a two-paragraph guide, ties by id.
- Computed once per session and reused byte-for-byte — the prompt cache stays warm; an empty store costs zero tokens.
- Token budget, CJK-aware (1.5 tokens per Chinese character, 4 characters per token otherwise). Over-budget indexes degrade in tiers: full hook lines → `- [id]`-only lines → a `（其余 N 条未展开…）` counter. A cut memory stays reachable through `evolve_read`.

### One write path

- `evolve_write(kind, …)` handles `create` / `update` / `delete` for `kind = memory | skill`, plus `move-to-global` for skills.
- Gates, one transaction: id shape, type enum, the feedback **Why:**/**How to apply:** contract, secret screening, 64KB body cap, optional `corrects` link, optional `notWhen` caveat; a memory `update` rewrites `active` rows only — archived or quarantined rows are refused by status (archive is history, quarantine waits for a human, so rebuilding is the only way forward).
- `evolve_read(kind, …)` serves bodies by id and searches by keyword: AND over the query's token groups (trigram FTS, LIKE underneath), then an OR pass, with CJK fragments expanded into 3-character windows.
- A body served by id bumps its view counter — a presence heartbeat, not proof of use. Long-unviewed rows become removal candidates; pruning stays human.

### Extraction

The trajectory-to-memory track, audited in `extraction_log`.

- Turn-level and **per session**: `agent/turn-stopping` schedules that session's boundary, coalescing (a run in flight keeps only the newest boundary, never a queue); `compaction/start` and session close drain it. **No idle timer.**
- A run reads the increment since its cursor, passes a cheap pre-gate, gets FTS-similar memories as context, and lands one LLM proposal through the same gates. A gate refusal consumes the increment as a model skip; an unclear gate fails open.
- A deterministic pre-screen drops proposals that duplicate an existing body or change nothing (`pre-screen: duplicate×N`). Failures never advance the cursor; every skip is ledgered.

### Quality review

The second background track, independent by construction: own prompts, own daily budget (100 items), own `review_log`, no cursor — only the write gates are shared.

- A cheap gate decides whether an entry deserves a close look; only approvals run the evolve pass.
- The evolve pass judges content quality and proposes a rewrite — memories on home-ownership plus accuracy/usability/reusability/duplication/freshness; skills on trigger precision/executability/duplication, with reuse judged scope-aware.
- Four outcomes: rewrite · quarantine (hidden, never deleted) · archive (history kept, excluded from injection) · advice-only "this belongs in the repo docs". The plugin never writes into your repository.
- New writes are reviewed as they land; requeues are event-driven; the calendar is only a sampling backstop (`review.staleDays`, the longest exemption window, doubles on consecutive keeps). Ships in dry-run.

### Layers and promotion

- L0 = about the person (global partition) · L1 = about a project · L2 = session state, never stored.
- L0 is not hand-maintained. A row reaches it only through **two independent judgements plus a 30-day probation**: extraction marks `scope=person`, then the review must say promote.
- The move is one transaction — global row built, project row archived, exactly one active copy — carrying the probation window and the origin partition.
- Probation rows are injected tagged「试用中」; at the window's end they are promoted, returned home, or quarantined. Physical deletion is always human.

### Rollback, hygiene, observability

- Every mutation lands before/after snapshots (`extraction_log`, `skill_log`, `review_log`); undo means rewriting the `before` values. All four ledgers rotate on one 30-day window.
- Hygiene rides on every applied run: orphan FTS rows dropped, secret-bearing rows quarantined (hidden, never deleted; a quarantined skill's file is removed so it stops loading), drifted skill files restored from the store.
- Diagnostics live in `plugin_log` — a stock host attaches no exporter.
- Three readings replace guesswork: **build identity** (import-time hash vs on-disk hash ⇒ a restart is owed) · **injection accounting** (`injection_log`, 7-day "injected N / read M" conversion — answers *was it read*, never *was it used*) · **recall evaluation** (`npm run eval:recall`, hit@1 and MRR; an empty fixture is red by design).

### Cards

- Mounted on the plugin's page in the official plugin manager; hosts without the slot silently degrade.
- Upper card: global `review.*` settings — explicit save; `enabled` needs a restart, the rest apply on the next drain.
- Lower card: read-only projection — build identity, 7-day conversion, workspace selector over the store's partitions, search, relative updated times, click-to-preview bodies (5 MiB cap), patrol warnings, archived zone (read-only, collapsed: reason + merge target, no actions), and skills (global rows badged, project shadows global) with view counts.

Types follow the ZCode taxonomy: `user` (profile and environment facts), `feedback` (corrected or confirmed practices — bodies must carry **Why:** and **How to apply:**), `reference` (resource pointers). `notWhen` is a one-sentence caveat rendered next to the hook ("不适用：…") — presentation only, never a retrieval filter. Extraction boundary: person- and environment-scoped knowledge; decisions and trade-offs are repo-scoped and belong to the repo's ADR route. Legacy markdown stores (`<workspace>/.evolve/memory/*.md`) are imported losslessly on first contact, and the directory is moved aside as `memory-imported-<date>/` — never deleted.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryIndex.enabled` | `true` | Register the memory section |
| `memoryIndex.guide` | `true` | Inject the guide (zero tokens when off and the index is empty) |
| `memoryIndex.order` | `400` | Section order (upstream named slots start at `PLAN_POLICY=500`) |
| `memoryIndex.maxTokens` | `6000` | Hard token budget for the injected index (CJK-aware; over-budget rows degrade to id-only lines) |
| `memoryIndex.extraction` | `true` | The proposal-based extraction run (turn-level, per-session slots, no idle timer) |
| `review.enabled` | `true` | The autonomous content-quality loop (own prompts/budget/ledger, trial dry-run) |
| `review.dryRun` | `true` | Ledger verdicts without landing them |
| `review.dailyBudget` | `100` | Reviewed items per UTC day (new > linkage/clock > sample; counters kept per source) |
| `review.batchSize` | `10` | Max items per drain run |
| `review.staleDays` | `30` | Longest exemption window: past it an item becomes *eligible* for sampling; consecutive keeps double it (30→60→120, capped) |
| `memoryCard.enabled` | `true` | Memory + review-settings cards in the plugin manager |

`memoryIndex.maxChars` (the pre-0.19 character cap) is read **once**: the first read converts it to tokens (`floor(chars / 1.5)`) and records that in the store, after which the token key is the only live source.

Every `review.*` field is volatile: the settings card edits it without a remount, and the scheduler re-reads the values on every drain.

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxTokens: 8000
      extraction: true
    review:
      dryRun: false
```

## Development

```bash
pnpm install && pnpm build   # deps + clean build -> lib/
pnpm test                    # vitest (948 tests / 77 files)
pnpm test:coverage           # v8 coverage, CI-enforced thresholds (91/83)
pnpm lint                    # oxlint src test client scripts
pnpm check:docs              # ADR format, doc budgets, links, governance, handoff
pnpm check:pack              # published-artifact consistency (also runs on prepack)
pnpm eval:recall             # offline recall baseline (hit@1 / MRR over a fixture)
```

| Path | Contents |
|---|---|
| `src/` | 77 modules: registration, store, `data/` back end, `services/` application services, `surfaces/` presentation, `pages/memory-card/` |
| `client/` | hand-written client bundle for the cards |
| `locale/` | localized display name and description (zh/en) |
| `scripts/` | gates (ADR, docs, layering, budgets, pack) and `eval:recall` |
| `test/` | vitest suite, 84 files |
| `docs/` | `design.md` (design) · `FAQ.md` (real-world pitfalls) |
| `.agents/` | AI collaboration layer (AGENTS.md, skills, ADR notes) |

## Docs

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md)
- Store decision: [`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)
- Observability batch: [`.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md`](.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md)

## License

MIT. Independent project — not affiliated with DeepSeek.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
