# dsh-continual-evolve

English | [中文](README.zh.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-656%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-97%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-92%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

A workspace-memory plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): every memory lives in one central SQLite database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace), the index is injected at session start, and the plugin's code is the literal **sole writer** — the model proposes, code gates and lands.

## Why

Reusable experience gathered in one session (user preferences, pitfalls, project context) is forgotten by the next. A folder of markdown files makes memory visible but leaves every write ungoverned: index drift, frontmatter rot, oversized files, and secrets are only visible *after* a bad write lands. This plugin keeps ZCode's memory shape (per-workspace partitioning, injected index, typed memories) but moves the store into one database whose every mutation passes mechanical gates.

## How it works

1. **Session-start injection** — the plugin registers a single system-prompt section: the workspace's memory index as a store query (hooks only, whole-line truncated over budget, ordered feedback > user > reference), the central-library path, and a three-line guide. The section is computed once per session and reused byte-for-byte, keeping the system prompt stable and the prompt cache warm; an empty store costs zero tokens.
2. **Two tools, one writer** — `evolve_write(kind, …)` (create/update/delete, plus an explicit `move-to-global` for skills) is the explicit path for "remember …" / "forget …" and for sedimenting reusable procedures: `kind` is `memory`, `skill`, or `prompt`, and every proposal passes the code gates (id shape, type enum, the feedback Why/How contract, secret screening carried over from v1, 64KB body cap, optional `corrects` links to the same-workspace active memory being superseded) inside one transaction. `evolve_read(kind, …)` fetches bodies by id and searches by keyword — whitespace-separated terms are AND-combined, with literal substring matching for short terms and whenever the trigram index misses; the injected index carries hooks only. Each body served by id increments that row's view counter (views + last viewed), a presence heartbeat — viewed, not applied, so long-unviewed rows are removal candidates while pruning itself stays human. Skills sediment through the same discipline (kebab ids, secret screening, 64KB cap, no duplicate ids or bodies across scopes); every applied skill is materialized by the plugin as `<workspace>/.agents/skills/<id>/SKILL.md` — the database is the source of truth, the files are a read-only projection patrol restores on drift; the project shadows a same-named global. On hosts without the tools service the plugin degrades to "tell the user" phrasing and stays functional.
3. **Proposal-based extraction** — the trajectory-to-memory automation, audited in the `extraction_log`: every `agent/turn-stopping` schedules that session's boundary, with state kept **per session** (a run in flight keeps only its newest boundary — coalescing, not queueing; `compaction/start` and session close drain it) and **no idle timer**. A run reads the session increment since its cursor, feeds FTS-similar existing memories to one LLM call, and the model's structured proposal lands through the same gates; failures and rejections never advance the cursor. A cheap pre-gate (increment head + ownership triple-test + landing-point test, tiny verdict; the increment head also carries a `tools-this-turn` line — names only, never arguments or paths) runs first: refusals consume the increment as a model skip without the full call, and an unclear gate fails open to the full call — worst case degrades to the old single-call behavior, never to a stall. Full and gate usages ledger in separate `usage` / `cheap_usage` columns, and a gate that dies keeps its error head in the same row's `cheap_error` — a dead gate stays tellable from a gate that never existed. Internal agents, empty increments, turns without real user prose, and turns that already carried an explicit `evolve_write` are mechanically skipped — and every skip is ledgered, consecutive quiet turns of one session as a single row carrying how many wake-ups it stands for. Both tracks resolve their route from the session's *current* selection first (its `modelSelection` projection, then its last request header, then the agent's creation-time options, then the host default — the order the host itself uses), trace which candidate answered once per drain, and share one failure discipline: a route the provider refuses (`AUTH`, `NO_ADAPTER`) stops being called until it changes, while transient faults back off 0 → 5min → 15min → 1h → 6h instead of re-sending the whole increment on every turn boundary.
4. **Autonomous content-quality loop** — the second background automation, independent from extraction by construction (own prompts, own daily budget, own `review_log` ledger, no cursor; only the store's write gates are shared): a cheap gate model call decides whether a memory/skill entry deserves a close look, and only approvals run the evolve pass that judges content quality (memories on home-ownership plus accuracy/usability/reusability/duplication/freshness, skills on home-ownership plus trigger precision/executability/duplication, where reuse is scope-aware: a project-partition skill is judged inside its project (in-project reuse) and the cross-project test applies to global-scope skills only — a repo-bound row in the global partition is the mis-homed case) and proposes the rewrite. Each of the four review jobs (memory and skill, gate and evolve) loads its own rubric from one subagent table — a single prompt cannot serve both, since a memory must survive having its repo name stripped while a project skill is supposed to be repo-bound. The same three home tests (user/environment vs repo-version subject, name-stripped sentence, repo facts live in ADR/docs) guard the extraction prompt, so repo-version specifics never enter as memories in the first place. Gate/leg failures ledger the error text instead of a bare code, along with the model they ran on and the tokens the failed call had already burned, and the output budget comes from the model's own advertised cap instead of a fixed number, so a thinking model is not cut off mid-verdict: a verdict that completed before a cut still counts, while a call that produced no verdict at all (route fault, budget cut) leaves the item queued instead of marking it reviewed. New writes are reviewed as they land; requeues are event-driven (a drop-in whose text lands near an existing item, a `corrects` link, or a correction-shaped feedback write records a linkage event — in the same transaction as the body — that puts the item back at the front), and the calendar is only a sampling backstop (`review.staleDays` is the longest exemption window — 30 days by default, doubled by consecutive keeps up to 120 — with a sample slot of a fifth of the batch). Verdicts reach four outcomes: rewrite, quarantine, archive (history kept, no longer injected; gated on zero references plus a second independent judgement and no correction pointing at it), and advice-only "this belongs in the repo docs" — the plugin never writes into your repository. Two hard guarantees bound the autonomy: delete never lands automatically (rewrite or quarantine only — quarantine hides, never deletes) and oversized rewrites degrade to quarantine. A daily cap (default 100 items, new > linkage/clock > sample priority, the tail drops instead of rolling over) bounds the token spend, and every terminal path lands one `item-review` verdict row plus one daily rollup row (budget vs reviewed vs backlog vs dropped, tokens split by cheap/evolve purpose) for later replay. Ships in trial mode (`review.dryRun`, default on): verdicts ledgered, nothing applied — and a declined rewrite now rides the row's `proposed` column, because a trial has to show what it would write, not just why. A refused route stops the whole drain after the first candidate — the remaining items stay queued, and no call is made again until the route changes — instead of each item buying the same refusal.
5. **Memory layers with a two-stage promotion funnel** — memories are either L0 (about the person: collaboration preferences, language, machine facts; kept in the global partition) or L1 (about a project); L2 (session/task state) never enters the store. L0 is not a hand-maintained partition: a row reaches it only through **two independent judgements and a 30-day probation** — extraction marks `scope=person` when all three ownership tests pass (the row stays in its project), and the review's second judgement must say promote. The move is one transaction (global row built, project row archived, exactly one active copy) and carries a 30-day probation plus the origin partition. Probation rows are injected like any other, tagged「试用中」; when the window closes the review promotes them (cross-partition use was recorded), returns them home, or quarantines them. That gives "wrong home" layered answers: promote what belongs to the person, only *advise* "this belongs in the repo docs" (the card shows the tag; the plugin never writes into your repository), quarantine what is wrong or stale, and archive what should never have existed (history kept, no longer injected). `evolve_write(kind=memory, action=move-to-global)` is the manual fallback; physical deletion is always human.
6. **Rollback is a ledger, not a mechanism** — every mutation lands an `extraction_log` row with full before/after snapshots; undo means rewriting the `before` values. Skill mutations land the same way in `skill_log`, review verdicts in `review_log`. A hygiene pass rides on every applied run: orphan FTS rows are dropped and secret-bearing rows are quarantined (hidden, never deleted; a quarantined skill's materialized file is removed so it stops loading). The read-only card surfaces quarantine anomalies. Plugin diagnostics have a durable home of their own: a stock host attaches no exporter to its logger, so `plugin_log` is the only home — the host logger is not mirrored. All four ledgers rotate on one 30-day window, pruned by a day-throttled check that rides store readiness, log writes and the post-extraction hygiene pass.
6. **Cards: memory + review settings** — mounted on the plugin's page in the official plugin manager (the `plugins.bundle.config` slot; hosts without it silently degrade to no card), shaped like the market's own settings cards and aligned with ZCode's Settings → Memory viewer. The upper card edits the global `review.*` settings (two switches plus three numbers, explicit save; `enabled` needs a restart, the rest apply on the next drain) and never follows the workspace selector; the lower card is the read-only memory projection: a dropdown scope selector over the store's workspace partitions (opening on the host's current workspace), a search box, per-entry relative updated times, click-to-preview bodies (5 MiB cap), patrol warnings, and a skills section listing the workspace's project skills plus visible global skills (global rows badged, project shadowing global) with the same preview, each row showing its view count. Localized through the host's `locale/*.json` metadata channel; host theme tokens, the `Button` primitive, and zh/en copy that tracks the DSH language. The memory card is a request-time projection of the database and has no edit path; the settings card writes through the host config editor so the profile patch stays the single source of truth.

Memory types follow the ZCode taxonomy: `user` (profile and environment facts), `feedback` (corrected or confirmed practices — bodies must carry **Why:** and **How to apply:** lines), `reference` (resource pointers). The extraction boundary is person- and environment-scoped knowledge only: decisions and trade-offs are repo-scoped by nature and belong to the repo's ADR route, never to memory.

Legacy markdown stores (`<workspace>/.evolve/memory/*.md`) are imported losslessly on first contact and the directory is renamed aside as `memory-imported-<date>/` — never deleted.

## Install

```bash
# From npm (activates on install — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# Or from source (approve the allowBuilds build step on first GitHub install)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

After installing or updating, restart the DSH profile you actually use (`dsh web` or the desktop host).

## Usage

No commands. On the first session after restart the index is injected automatically. Just tell the model "remember …" / "forget …" — it lands through `evolve_write` and the gates. To sediment a reusable procedure, tell the model to save it as a skill — it lands through `evolve_write` in the current project and materializes as a `SKILL.md` the `skill` tool discovers after restart; say "use it everywhere" and the model moves it to the global scope (the project copy archives). Memories and skills written mid-session become visible in the next session (the section is frozen to protect the prompt cache). To see the whole store, open the plugin's page in the official plugin manager: the memory card shows each workspace's entries and skills, search, and patrol anomalies, and the settings card above it edits the global `review.*` values. The store requires Node ≥ 22.5 (`node:sqlite`, part of the desktop host's EnsureNode runtime); without it the plugin degrades to a no-op with a console warning.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryIndex.enabled` | `true` | Register the memory section |
| `memoryIndex.guide` | `true` | Inject the guide (zero tokens when off and the index is empty) |
| `memoryIndex.order` | `400` | Section order (upstream named slots start at `PLAN_POLICY=500`) |
| `memoryIndex.maxChars` | `6000` | Hard character budget for the injected index |
| `memoryIndex.extraction` | `true` | The proposal-based extraction run (turn-level, per-session slots, no idle timer) |
| `review.enabled` | `true` | The autonomous content-quality loop (own prompts/budget/ledger, trial dry-run) |
| `review.dryRun` | `true` | Ledger verdicts without landing them (flip off after the trial distribution reads clean) |
| `review.dailyBudget` | `100` | Reviewed items per UTC day (new > linkage/clock > sample, tail drops; counters kept per source) |
| `review.batchSize` | `10` | Max items per drain run |
| `review.staleDays` | `30` | Longest exemption window: past it an item becomes *eligible* for sampling (never a guaranteed re-review); consecutive keeps double it (30→60→120, capped); a review that produced no verdict never counts |
| `memoryCard.enabled` | `true` | Memory + review-settings cards in the official plugin manager (degrades to no card when the host lacks `webServer`/`plugins.bundle.config`) |

Every `review.*` field is volatile: the settings card edits it without a remount, and the scheduler re-reads the values on every drain.

Profile patch example:

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
      extraction: true
    review:
      dryRun: false
```

## Development

```bash
pnpm install && pnpm build   # deps + clean build -> lib/
pnpm test                    # vitest (656 tests)
pnpm test:coverage           # v8 coverage, CI-enforced thresholds
pnpm lint                    # oxlint src test client
pnpm check:pack              # published-artifact consistency (also runs on prepack)
```

Layout:

```
├── src/
│   ├── index.ts            # registration: config + host shapes + apply orchestration
│   ├── assemble.ts         # shared mounts: tools + extraction + review + creator skills
│   ├── store.ts            # store assembly: open/migrate, per-kind method builders, re-exports
│   ├── store-types.ts      # store surface (single MemoryStore) + ledger/account shapes
│   ├── data/               # storage back end: database, generic repository + descriptors,
│   │                       # row/record shapes (single home), secret screen, migration, ledgers,
│   │                       # review accounts, patrol
│   ├── services/           # application services: write gates (rules + batch application),
│   │                       # extraction/review loops (schedulers, chains, prompts, subagents),
│   │                       # route resolution + failure discipline (model-route, extraction-failure),
│   │                       # transport, accounting, retention, md import, skill files, plugin log
│   ├── pages/
│   │   └── memory-card/    # the plugin-manager page: routes + settings + mount + hint
│   └── surfaces/           # presentation: unified evolve_* tools, injection, snapshots,
│                           # section text + guide, creator-skill provider (read-only, patrol-reconciled)
├── client/
│   └── client.js          # hand-written client bundle: memory + review-settings cards
├── locale/                # host package metadata: localized display name + description (zh/en)
├── test/                  # vitest suite (48 files)
├── lib/                   # build output (tsc)
├── docs/                  # design.md (design) · FAQ.md (real-world pitfalls)
└── .agents/               # AI collaboration layer (AGENTS.md, skills, ADR notes)
```

## Docs

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md) · Store decision: [`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)

## License

MIT. Independent project — not affiliated with DeepSeek.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
