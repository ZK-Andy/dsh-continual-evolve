# dsh-continual-evolve

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-62%20passing-brightgreen)]()
[![Status](https://img.shields.io/badge/status-Phase%203%20%2F%20benchmark%20validation-ff69b4)]()

Continual self-evolution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a versioned, auditable, rollback-safe layer of harness state — prompt notes, memories, skills, and subagent specs — refined from session trajectories.

> **Status: Phase 3 (benchmark-driven validation loop).** On top of the
> completed Phase 2, an evaluation matrix runner (host-plane `subagents`,
> frozen runtime, structured-output cells) feeds a code-owned scoreboard; the
> non-regressive acceptance rule decides accept/reject with no model-written
> aggregates.

## Background

This project started as a research question: *can a harness improve itself,
and what would a production-grade version look like?* Three lines of evidence
shaped the answer:

- **penguin-harness** demonstrated the concept (benchmark → evaluate →
  optimize → accept/rollback) but with **zero code-level enforcement** — every
  guarantee was a prompt contract. Its report (`docs/research/`) became the
  hardening checklist this project implements.
- **prime-agent `/refine`** proved the engineering shape: versioned harness
  entries, atomic persistence, optimistic concurrency, inverse-op rollback.
  This package is an original implementation of that shape on the DSH plugin
  surface.
- Academic work (Self-Harness, AHE, HarnessOpt-Bench) supplied the discipline:
  frozen evaluation runtime, code-owned aggregation, non-regressive
  acceptance.

The result: **the model proposes, the code guarantees.** Every mechanical
safety property (schema validation, snapshots, versioning, audit trail,
acceptance decisions) is enforced in code — never by asking the model to
behave.

## Why

Agents accumulate reusable experience in every session — repeated failures, durable facts, reusable procedures — and then forget it at the next turn or session. This plugin makes that experience first-class persistent state:

- **Versioned entries** keyed by kind (`prompt` / `memory` / `skill` / `subagent`), each with a recorded provenance and version
- **Evidence trail**: every refinement appends an event carrying `trigger / changes / evidence / outcome`
- **Deterministic rollback**: inverse edits are generated from applied results — no LLM re-guessing
- **Code-enforced safety**, not prompt discipline: schema validation, atomic writes, corrupt-file degrade, optimistic concurrency, immutable base system prompt
- **Local (session) and global (cross-session) scopes** with merge semantics

## Design provenance

Inspired by three bodies of work (see [`docs/design.md`](docs/design.md)):

- **prime-agent `/refine`** (MIT): the state model, atomic persistence, optimistic concurrency, per-edit validation, and inverse-op rollback this package implements — annotated reference source in [`docs/research/prime-agent-refinement.ts`](docs/research/prime-agent-refinement.ts). The code here is an original implementation, written for the DSH plugin surface.
- **penguin-harness** (Apache-2.0): the benchmark-driven evolution loop — research report in [`docs/research/penguin-harness-self-evolution.md`](docs/research/penguin-harness-self-evolution.md); its prompt-only contracts are the anti-pattern this package hardens.
- Academic: Self-Harness (arXiv 2606.09498), AHE (arXiv 2604.25850), HarnessOpt-Bench (arXiv 2608.06301).

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, ES2024, ESM) |
| Runtime | Node `^22.19.0 \|\| >=24.0.0` (matches DSH) |
| Plugin seam | `@deepseek-ai/cordis` (`name` / `apply` / `inject` entry) |
| Package manager | pnpm (DSH ecosystem standard) |
| Build | `tsc` → `lib/` (main `lib/index.js`, types `lib/index.d.ts`) |
| Tests | Vitest |
| Lint | oxlint (DSH official repo convention) |
| License | MIT |

## Project layout

```
dsh-continual-evolve/
├── package.json          # exports map, files, engines, scripts
├── tsconfig.json         # strict es2024 bundler config (DSH conventions)
├── .oxlintrc.json        # oxlint config
├── .editorconfig
├── .gitignore
├── LICENSE               # MIT
├── README.md
├── src/
│   ├── index.ts          # cordis plugin entry (service mount)
│   ├── types.ts          # HarnessState / entry / edit / result types
│   ├── state.ts          # atomic persistence, corrupt degrade, merge, concurrency
│   ├── validate.ts       # code-enforced edit validation
│   ├── apply.ts          # per-edit apply pass with optimistic locking
│   ├── rollback.ts       # deterministic inverse-op rollback
│   └── plan.ts           # proposal JSON parsing (truncation-aware)
└── test/
    ├── state.test.ts
    ├── validate.test.ts
    └── apply.test.ts
```

## In-session usage (after restart)

```
/evolve                  help + current local store
/evolve list [global]    list entries
/evolve history          applied refinements (ids for rollback)
/evolve rollback <id>    deterministically revert a refinement
/evolve plan [msg]       LLM planner against the current store
```

Model-facing tools: `evolve_list`, `evolve_add`, `evolve_update`, `evolve_delete`, `evolve_rollback`.

## Benchmark-driven validation (Phase 3)

```
/evolve benchmark new <title>                          create a benchmark
/evolve benchmark add-case <bid> <title> <statement> <rubric>
/evolve benchmark list                                 list benchmarks
/evolve benchmark status <bid>                         scoreboard + decisions
/evolve benchmark run <bid>                            evaluate current state → reference
/evolve benchmark run <bid> candidate <refinementId>   evaluate post-refinement state → decide
```

The loop: freeze a reference score → evolve a candidate (`/evolve plan`) →
run the same case × run matrix against the post-refinement state → the
**code-owned** acceptance rule keeps the candidate only if the overall mean
strictly improves with no case regressing (Self-Harness style). The model
produces raw per-cell scores only; aggregation and decisions live in
`src/score.ts`. Rubric isolation is by construction (the planner never sees
rubric files); rejection is recorded and suggested for rollback (human in
the loop, no auto-rollback).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseDir` | resolved DSH home | root for the `evolve/` stores |
| `sectionOrder` | 118 | system-prompt section order |
| `autoReview` | `false` | enable the automatic review gate (costs a cheap model call per interval) |
| `reviewIntervalTurns` | 6 | gate runs when this many turns passed since the last review |
| `maxReviewInputChars` | 40000 | trajectory slice handed to the gate |
| `reviewBudgetTokens` | 4096 | output budget for the gate call |
| `requireGlobalApproval` | `true` | cross-session (global) edits ask the user for "批准" before applying |
| `skillsDir` | `<dshHome>/skills` | root where skill entries materialize as SKILL.md bundles |

Example (profile `cordis.patch.yml`):

```yaml
- insert:
    - id: continual-evolve
      name: 'dsh-continual-evolve'
      config:
        autoReview: true
        reviewIntervalTurns: 6
```

## Development

```bash
pnpm install        # install dev deps
pnpm build          # tsc -> lib/
pnpm test           # vitest run
pnpm lint           # oxlint src test
```

## Roadmap

- **Phase 1 (done)**: pure-core engine — state model, validation, apply, rollback, proposal parsing; tested.
- **Phase 1b (done)**: `evolve_*` tools, `/evolve` command, and the `ctx.llm` planner; installed into the web profile.
- **Phase 2 (done)**: ✅ auto-refine review gate (turn-interval checkpoints); ✅ compaction checkpoint (`compaction/start`); ✅ global-scope approval gate (userQuestions); ✅ executable skills (materialize to `$DSH_HOME/skills/`).
- **Phase 3 (done)**: ✅ benchmark-driven validation loop — evaluation matrix via the workflow engine, code-owned scoreboard aggregation, non-regressive acceptance rule, rubric isolation by construction. (Future: sandbox ACL isolation of rubrics, automated rollback on rejection.)

## License

MIT. Independent project — not affiliated with DeepSeek.
