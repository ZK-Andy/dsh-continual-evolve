# dsh-continual-evolve

English | [中文](README.zh.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-696%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-97%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-92%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-99%25-brightgreen)]()

A workspace-memory plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Every memory lives in one central SQLite database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace), the index is injected at session start, and the plugin's code is the literal **sole writer** — the model proposes, code gates and lands.

## Why

Reusable experience gathered in one session is forgotten by the next. A folder of markdown files makes memory visible but leaves every write ungoverned: index drift, frontmatter rot, oversized files and secrets only show up *after* a bad write lands. This plugin keeps ZCode's memory shape (per-workspace partitioning, injected index, typed memories) and moves the store into one database whose every mutation passes mechanical gates. Four things it can answer with data rather than vibes: *which build is this process running*, *was the injected index ever read*, *what did the budget leave out*, and *did the last retrieval change make recall better or worse*.

## How it works

1. **Session-start injection.** One system-prompt section: the workspace's memory index as a store query (hooks only, ordered feedback > user > reference, ties broken by id), the database path, and a short guide. The section is computed once per session and reused byte-for-byte, so the prompt cache stays warm; an empty store costs zero tokens.
2. **A token budget that degrades instead of dropping.** The budget is tokens, estimated CJK-aware (1.5 tokens per Chinese character, 4 characters per token otherwise). An index that does not fit degrades in tiers: full hook lines → `- [id]`-only lines → a `（其余 N 条未展开…）` counter — a memory the budget could not afford stays discoverable by `evolve_read` instead of vanishing.
3. **Two tools, one writer.** `evolve_write(kind, …)` (create/update/delete, `move-to-global` for skills) is the explicit path for "remember …" / "forget …" and for sedimenting procedures — `kind` is `memory`, `skill` or `prompt`, and every proposal passes the gates (id shape, type enum, the feedback **Why:**/**How to apply:** contract, secret screening, 64KB body cap, optional `corrects` link, optional `notWhen` caveat) inside one transaction. `evolve_read(kind, …)` serves bodies by id and searches by keyword: an AND over the query's token groups first (trigram FTS, LIKE underneath), then — because a question is not a keyword list — an OR pass over the same alternatives, with CJK fragments expanded into 3-character windows. Each body served by id bumps that row's view counter: a presence heartbeat, so long-unviewed rows are removal candidates while pruning itself stays human.
4. **Proposal-based extraction.** The trajectory-to-memory automation, audited in `extraction_log`. Every `agent/turn-stopping` schedules that session's boundary, state kept **per session** (coalescing, not queueing; `compaction/start` and session close drain it), **no idle timer**. A run reads the increment since its cursor, feeds FTS-similar memories to one LLM call, and the answer lands through the same gates; failures never advance the cursor. A cheap pre-gate (tiny verdict on the increment head) runs first: a refusal consumes the increment as a model skip, an unclear gate fails open to the full call. Full and gate usages ledger in separate columns, and a dead gate keeps its error head in `cheap_error`. Before anything is written, a **deterministic pre-screen** drops proposals that duplicate an existing body or change nothing; the reason lands as `pre-screen: duplicate×N`.
5. **Autonomous content-quality loop.** The second background automation, independent by construction (own prompts, own daily budget, own `review_log`, no cursor; only the write gates are shared). A gate call decides whether an entry deserves a close look; only approvals run the evolve pass that judges content quality (memories: home-ownership plus accuracy/usability/reusability/duplication/freshness; skills: trigger precision/executability/duplication, reuse judged scope-aware) and proposes a rewrite. Each of the four review jobs loads its own rubric from one subagent table. Gate/leg failures ledger the error text, the model and the tokens already burned; a verdict that completed before a budget cut still counts, while a call that produced no verdict leaves the item queued. New writes are reviewed as they land; requeues are event-driven (a nearby landing, a `corrects` link, a correction-shaped feedback write). Both tracks resolve their route from the session's *current* selection and share one failure discipline: a refused route (`AUTH`, `NO_ADAPTER`) stops being called until it changes; transient faults back off 0 → 5min → 15min → 1h → 6h.
6. **Memory layers and a two-stage promotion funnel.** L0 = about the person (kept in the global partition), L1 = about a project; L2 session state never enters the store. A row reaches L0 only through **two independent judgements plus a 30-day probation**: extraction marks `scope=person` when all three home tests pass, and the review's second judgement must say promote. The move is one transaction (global row built, project row archived, exactly one active copy) carrying the probation window and the origin partition; probation rows are injected tagged「试用中」. At the window's end the row is promoted (cross-partition use was recorded), returned home, or quarantined. Wrong-home layers: promote what belongs to the person, *advise* "this belongs in the repo docs" (card tag only — the plugin never writes into your repository), quarantine wrong or stale rows, archive what should never have existed. Physical deletion is always human.
7. **Observability built in.** (a) **Build identity** — the process hashes its own entry file at import (`codeGeneration`) and re-reads it on demand (`diskGeneration`); they differ ⇒ the host must restart. (b) **Injection accounting** — one row per session in `injection_log` (ids named by the index, estimated tokens, 30-day retention); the card shows a 7-day "injected N / read M (X%)" conversion, where *read* means the body was served after the injection that named it. Its limit is stated, not hidden: it answers "was it read", never "did the answer use it". (c) **A recall evaluation** — `npm run eval:recall` seeds a throwaway store from a fixture and reports hit@1 and MRR; an empty fixture is red by design.
8. **Rollback is a ledger, not a mechanism.** Every mutation lands a row with before/after snapshots (`extraction_log`, `skill_log`, `review_log`); undo means rewriting the `before` values. A hygiene pass rides on every applied run: orphan FTS rows dropped, secret-bearing rows quarantined (hidden, never deleted; a quarantined skill's materialized file is removed so it stops loading). Plugin diagnostics have a durable home of their own (`plugin_log`) because a stock host attaches no exporter; all four ledgers rotate on one 30-day window.
9. **Cards: memory + review settings.** Mounted on the plugin's page in the official plugin manager (hosts without the slot silently degrade). The upper card edits the global `review.*` settings (explicit save; `enabled` needs a restart, the rest apply on the next drain) and never follows the workspace selector. The lower card is the read-only projection: build identity (red when a restart is owed), 7-day injection conversion, a workspace selector over the store's partitions, search, relative updated times, click-to-preview bodies (5 MiB cap), patrol warnings, and a skills section (global rows badged, project shadows global) with view counts. Localized through the host's `locale/*.json` channel and theme tokens.

Memory types follow the ZCode taxonomy: `user` (profile and environment facts), `feedback` (corrected or confirmed practices — bodies must carry **Why:** and **How to apply:** lines), `reference` (resource pointers). `notWhen` is an optional one-sentence caveat rendered next to the hook ("不适用：…"); it is presentation only and never filters retrieval. The extraction boundary is person- and environment-scoped knowledge: decisions and trade-offs are repo-scoped and belong to the repo's ADR route.

Legacy markdown stores (`<workspace>/.evolve/memory/*.md`) are imported losslessly on first contact and the directory is renamed aside as `memory-imported-<date>/` — never deleted.

## Install

```bash
# From npm (activates on install — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# Or from source (approve the allowBuilds build step on first GitHub install)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

After installing or updating, restart the profile you actually use (the desktop host or `dsh <profile>`).

## Usage

No commands. On the first session after restart the index is injected automatically; tell the model "remember …" / "forget …" and it lands through `evolve_write` and the gates. To sediment a procedure, ask for it as a skill — it materializes as a `SKILL.md` the `skill` tool discovers after restart; say "use it everywhere" and the model moves it to the global scope (the project copy archives). Mid-session writes become visible in the next session (the section is frozen to protect the prompt cache).

To check the install after a restart: open the plugin's page in the official plugin manager — the first line shows the running generation against the one on disk, and turns red with "restart the host" when they differ. `plugin_log` carries the same reading as a `build-identity` row. The store requires Node ≥ 22.5 (`node:sqlite`); without it the plugin degrades to a no-op with a console warning.

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
pnpm test                    # vitest (696 tests)
pnpm test:coverage           # v8 coverage, CI-enforced thresholds (91/83)
pnpm lint                    # oxlint src test client scripts
pnpm check:docs              # ADR format, doc budgets, links, governance, handoff
pnpm check:pack              # published-artifact consistency (also runs on prepack)
pnpm eval:recall             # offline recall baseline (hit@1 / MRR over a fixture)
```

Layout (71 modules under `src/`, 55 test files):

```
├── src/
│   ├── index.ts            # registration: config + host shapes + apply orchestration
│   ├── assemble.ts         # shared mounts: tools + extraction + review + creator skills
│   ├── store.ts            # store assembly: open/migrate, per-kind method builders, re-exports
│   ├── store-types.ts      # store surface (single MemoryStore) + ledger/account shapes
│   ├── data/               # storage back end: database, generic repository + descriptors,
│   │                       # row/record shapes (single home), secret screen, migration, ledgers,
│   │                       # review accounts, item events, injection ledger, patrol
│   ├── services/           # application services: write gates, extraction/review loops,
│   │                       # proposal pre-screen, route resolution + failure discipline,
│   │                       # token budget, build identity, extraction accounting + stats,
│   │                       # transport, retention, md import, skill files, plugin log
│   ├── pages/
│   │   └── memory-card/    # the plugin-manager page: routes + settings + mount + hint
│   └── surfaces/           # presentation: unified evolve_* tools, injection (renderer +
│                           # budget tiers), snapshots, guide, creator-skill provider
├── client/
│   └── client.js          # hand-written client bundle: memory + review-settings cards
├── locale/                # host package metadata: localized display name + description (zh/en)
├── scripts/               # gates (ADR/docs/layering/budgets/pack) + eval:recall
├── test/                  # vitest suite (55 files)
├── lib/                   # build output (tsc)
├── docs/                  # design.md (design) · FAQ.md (real-world pitfalls)
└── .agents/               # AI collaboration layer (AGENTS.md, skills, ADR notes)
```

## Docs

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md)
- Store decision: [`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)
- Observability batch: [`.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md`](.agents/notes/implemented/architecture/2026-10-18-absorb-memory-plugin-strengths.md)

## License

MIT. Independent project — not affiliated with DeepSeek.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
