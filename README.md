# dsh-continual-evolve

English | [中文](README.zh.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-199%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-97%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-91%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

A workspace-memory plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): every memory lives in one central SQLite database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace), the index is injected at session start, and the plugin's code is the literal **sole writer** — the model proposes, code gates and lands.

## Why

Reusable experience gathered in one session (user preferences, pitfalls, project context) is forgotten by the next. A folder of markdown files makes memory visible but leaves every write ungoverned: index drift, frontmatter rot, oversized files, and secrets are only visible *after* a bad write lands. This plugin keeps ZCode's memory shape (per-workspace partitioning, injected index, typed memories) but moves the store into one database whose every mutation passes mechanical gates.

## How it works

1. **Session-start injection** — the plugin registers a single system-prompt section: the workspace's memory index as a store query (hooks only, whole-line truncated over budget, ordered feedback > user > reference), the central-library path, and a three-line guide. The section is computed once per session and reused byte-for-byte, keeping the system prompt stable and the prompt cache warm; an empty store costs zero tokens.
2. **Two tools, one writer** — `memory_write` (create/update/delete) is the explicit path for "remember …" / "forget …": every proposal passes the code gates (id shape, type enum, the feedback Why/How contract, secret screening carried over from v1, 64KB body cap) inside one transaction. `memory_read` fetches bodies by id and searches by keyword — whitespace-separated terms are AND-combined, with literal substring matching for short terms and whenever the trigram index misses; the injected index carries hooks only. On hosts without the tools service the plugin degrades to "tell the user" phrasing and stays functional.
3. **Proposal-based extraction** — the only background automation, audited in the `extraction_log`: every `agent/turn-stopping` schedules that session's boundary, with state kept **per session** (a run in flight keeps only its newest boundary — coalescing, not queueing; `compaction/start` and session close drain it) and **no idle timer**. A run reads the session increment since its cursor, feeds FTS-similar existing memories to one LLM call, and the model's structured proposal lands through the same gates; failures and rejections never advance the cursor. Internal agents, empty increments, turns without real user prose, and turns that already carried an explicit `memory_write` are mechanically skipped — and every skip is ledgered, consecutive quiet turns of one session as a single row carrying how many wake-ups it stands for.
4. **Rollback is a ledger, not a mechanism** — every mutation lands an `extraction_log` row with full before/after snapshots; undo means rewriting the `before` values. A hygiene pass rides on every applied run: orphan FTS rows are dropped and secret-bearing rows are quarantined (hidden, never deleted). The read-only card surfaces quarantine anomalies.
5. **Read-only card** — mounted on the plugin's page in the official plugin manager (the `plugins.bundle.config` slot; hosts without it silently degrade to no card), shaped like the market's own settings card and aligned with ZCode's Settings → Memory viewer: a dropdown scope selector over the store's workspace partitions (opening on the host's current workspace), a search box, per-entry relative updated times, click-to-preview bodies (5 MiB cap), and patrol warnings. Localized through the host's `locale/*.json` metadata channel; host theme tokens, the `Button` primitive, and zh/en copy that tracks the DSH language. The card is a request-time projection of the database and has no edit path.

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

No commands. On the first session after restart the index is injected automatically. Just tell the model "remember …" / "forget …" — it lands through `memory_write` and the gates. Memories written mid-session become visible in the next session (the section is frozen to protect the prompt cache). To see the whole store, open the plugin's page in the official plugin manager: the read-only card shows each workspace's entries, search, and patrol anomalies. The store requires Node ≥ 22.5 (`node:sqlite`, part of the desktop host's EnsureNode runtime); without it the plugin degrades to a no-op with a console warning.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryIndex.enabled` | `true` | Register the memory section |
| `memoryIndex.guide` | `true` | Inject the guide (zero tokens when off and the index is empty) |
| `memoryIndex.order` | `400` | Section order (upstream named slots start at `PLAN_POLICY=500`) |
| `memoryIndex.maxChars` | `6000` | Hard character budget for the injected index |
| `memoryIndex.extraction` | `true` | The proposal-based extraction run (turn-level, per-session slots, no idle timer) |
| `memoryCard.enabled` | `true` | Read-only memory card in the official plugin manager (degrades to no card when the host lacks `webServer`/`plugins.bundle.config`) |

Profile patch example:

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
      extraction: true
```

## Development

```bash
pnpm install && pnpm build   # deps + clean build -> lib/
pnpm test                    # vitest (199 tests)
pnpm test:coverage           # v8 coverage, CI-enforced thresholds
pnpm lint                    # oxlint src test client
pnpm check:pack              # published-artifact consistency (also runs on prepack)
```

Layout:

```
├── src/
│   ├── index.ts            # registration: section + tools + extraction + card wiring
│   ├── store.ts            # central SQLite store: DDL/WAL/FTS, reads, ledger, patrol, cursors
│   ├── store-apply.ts      # the sole write gate: validate all, apply atomically, ledger
│   ├── memory-rules.ts     # mechanical gates: enums, sizes, id shape, secret screening
│   ├── memory-section.ts   # injection: store query / truncate / session freeze
│   ├── memory-guide.ts     # the main-session guide (three lines)
│   ├── memory-tools.ts     # memory_write + memory_read (host-shaped definitions)
│   ├── extraction.ts       # runner + per-session scheduler (turn-level, no idle timer)
│   ├── extraction-surface.ts # trajectory slicing: cursor, eligibility, serialization
│   ├── extraction-prompt.ts  # the extraction prompt + answer parsing
│   ├── import-md.ts        # lossless legacy markdown migration
│   ├── memory-snapshot.ts  # card: read-only store projection (entries / patrol / degrade)
│   ├── card-routes.ts      # card: GET-only read API on the host webServer
│   └── workspace-hint.ts   # card: the host's current workspace as the opening default
├── client/
│   └── client.js          # hand-written client bundle: read-only card in the plugin manager
├── locale/                # host package metadata: localized display name + description (zh/en)
├── test/                  # vitest suite (16 files)
├── lib/                   # build output (tsc)
├── docs/                  # design.md (design) · FAQ.md (real-world pitfalls)
└── .agents/               # AI collaboration layer (AGENTS.md, skills, ADR notes)
```

## Docs

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md) · Store decision: [`.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md`](.agents/notes/implemented/architecture/2026-10-06-sqlite-single-store.md)

## License

MIT. Independent project — not affiliated with DeepSeek.
