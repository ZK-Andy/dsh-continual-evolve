# dsh-continual-evolve

English | [中文](README.zh.md)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-91%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-96%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-93%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-100%25-brightgreen)]()

A workspace-memory plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): one plain-markdown memory store per workspace (`<workspace>/.evolve/memory/`), the index injected at session start, used by the model with its **native file tools** — and nothing else.

## Why

Reusable experience gathered in one session (user preferences, pitfalls, project context) is forgotten by the next. ZCode solves this with a folder: one fact per markdown file plus a `MEMORY.md` index, injected at session start, read and written natively by the model, with no dedicated machinery. This plugin brings that exact shape to DSH.

## How it works

1. **Session-start injection** — the plugin registers a single system-prompt section: the `MEMORY.md` index content (whole-line truncated over budget, with a read-the-directory hint), the absolute store path, and the when_to_save guide. The section is computed once per session and reused byte-for-byte, keeping the system prompt stable and the prompt cache warm; an empty store costs zero tokens.
2. **Native read/write** — DSH fully permits file access inside the workspace (reads are never fenced; the write fence only covers paths outside the workspace, see [`docs/FAQ.md`](docs/FAQ.md) #6). The model reads, writes, and edits memory files and maintains the index directly; the store is bootstrapped on first use.
3. **Governance is the file** — no versions, no snapshots, no approvals, no background extraction: a bad memory is a visible file in the workspace, and deleting it is the retirement path. Memories are personal context — on bootstrap in a git workspace the store appends `.evolve/` to the workspace `.gitignore` (non-git workspaces are left untouched).
4. **Read-only card** — the plugin mounts a read-only memory card on its own page in the official plugin manager (the `plugins.bundle.config` slot; hosts without it silently degrade to no card), shaped like the market's own settings card (collapsed by default, header toggle with a rotating chevron, hover/open frame states) and aligned with ZCode's Settings → Memory viewer: one workspace at a time behind a dropdown scope selector fed by the host workspace registry, a file search box, per-file relative updated times, click-to-preview file bodies (5 MiB cap), plus index-drift warnings (unindexed files, index rows whose file is gone). The plugin's display name and description localize through the host's package `locale/*.json` metadata channel. The card follows the market's look — host theme tokens, the `Button` primitive for refresh, and zh/en copy that tracks the DSH language (plain themed elements on old hosts). The card is a request-time projection of the files on disk — the single source of truth remains `.evolve/memory/`; the card has no edit path, edit the files directly.

Memory file format (same as ZCode): frontmatter with `name` / `description` (the hook that decides whether a future session recalls it) / `metadata.type` (`user | feedback | project | reference`); `feedback` bodies must carry **Why:** and **How to apply:** lines.

## Install

```bash
# From npm (activates on install — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# Or from source (approve the allowBuilds build step on first GitHub install)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

After installing or updating, restart the DSH profile you actually use (`dsh web` or the desktop host).

## Usage

No commands, no tools. On the first session after restart, `.evolve/memory/` is created and the index is injected automatically. Just tell the model "remember …" / "forget …" — the memory files plus their index lines are the entire persistent state. Memories written mid-session become visible in the next session (the section is frozen to protect the prompt cache); for an immediate look the model simply reads the directory. To see the whole store, open the plugin's page in the official plugin manager: the read-only card shows each workspace's entries and index drift.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `memoryIndex.enabled` | `true` | Register the memory section |
| `memoryIndex.guide` | `true` | Inject the when_to_save guide (zero tokens when off and the index is empty) |
| `memoryIndex.order` | `400` | Section order (upstream named slots start at `PLAN_POLICY=500`) |
| `memoryIndex.maxChars` | `6000` | Hard character budget for the injected index |
| `memoryCard.enabled` | `true` | Read-only memory card in the official plugin manager (degrades to no card when the host lacks `webServer`/`plugins.bundle.config`) |

Profile patch example:

```yaml
- id: continual-evolve
  config:
    memoryIndex:
      maxChars: 8000
```

## Development

```bash
pnpm install && pnpm build   # deps + tsc -> lib/
pnpm test                    # vitest (91 tests)
pnpm test:coverage           # v8 coverage, CI-enforced thresholds
pnpm lint                    # oxlint src test client
```

Layout:

```
├── src/
│   ├── index.ts           # registration: the one section + config + card route wiring
│   ├── memory-section.ts  # injection: read index / bootstrap / truncate / session freeze
│   ├── memory-guide.ts    # guide: when_to_save and upkeep (adapted from ZCode)
│   ├── memory-snapshot.ts # card: read-only store projection (entries / drift / error degrade)
│   ├── workspace-catalog.ts# card: workspace list from the host registry (the API read fence)
│   ├── known-workspaces.ts# card: in-process LRU fallback source for the catalogue
│   └── card-routes.ts     # card: GET-only read API on the host webServer
├── client/
│   └── client.js          # hand-written client bundle: read-only card in the plugin manager
├── locale/                # host package metadata: localized display name + description (zh/en)
├── test/                  # vitest suite (8 files)
├── lib/                   # build output (tsc)
├── docs/                  # design.md (design) · FAQ.md (real-world pitfalls)
└── .agents/               # AI collaboration layer (AGENTS.md, skills, ADR notes)
```

## Docs

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md) · Teardown decision: [`.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md`](.agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md)

## License

MIT. Independent project — not affiliated with DeepSeek.
