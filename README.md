# dsh-continual-evolve

[中文](README.zh.md) | English

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-538%20passing-brightgreen)]()

Continual self-evolution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a versioned, auditable, rollback-safe harness state layer — prompt notes, memories, skills, subagent specs — refined from session trajectories.

**The model proposes, the code guarantees.** Every mechanical safety property — schema validation, atomic writes, snapshots, versioning, audit trail, acceptance decisions — is enforced in code, never by prompt discipline.

## Why

Agents accumulate reusable experience (repeated failures, durable facts, reusable procedures) and forget it next session. This plugin turns that experience into first-class state:

- **Local scope** per session; **global scope** across sessions with merge semantics — plus mechanical promotion guards so only portable, substantial, non-duplicate knowledge reaches global
- **Deterministic rollback**: inverse edits generated from applied results — no LLM re-guessing
- **Benchmark loop**: candidate refinements are evaluated against frozen cases by a separate scorer before acceptance (rubric encrypted at rest)

## How it works

1. **Sediment** — the model creates entries via `evolve_add`, or the automatic review gate proposes them from the session trajectory (turn-interval + compaction checkpoints).
2. **Guard** — code-enforced validation: edit schema, blast-radius/scope coherence, and the promotion policy (project-scoped markers, thin content, near-duplicate detection keep the global store clean). Global creates that near-duplicate an existing entry are rejected at write time (≥0.8 similarity); moderate overlaps carry a `conflictHint` for later consolidation.
3. **Approve** — global writes require explicit human approval; local-fate proposals are consulted before they land.
4. **Apply & inject** — atomic apply with snapshot + audit event. Prompt notes and delegation specs inject into the system prompt (capped, relevance-ranked, zero tokens when empty); memories/skills appear as a capped directory index.
5. **Validate & roll back** — benchmarks score candidates against frozen cases; rejected candidates roll back deterministically.

## Install

```bash
# from npm (installs and activates — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# or from source (first GitHub installs require approving the allowBuilds step)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

Restart `dsh web` after installing or updating.

## Usage

Commands (in-session):

| Command | Effect |
|---|---|
| `/evolve` | help + current local store |
| `/evolve list · history · rollback <id>` | inspect and revert (add `global` for the cross-session store) |
| `/evolve plan [msg]` | run the LLM planner against the store |
| `/evolve wrapup` | assess this session's local entries: promote / archive / keep |
| `/evolve archive · unarchive · demote <id>` | hide from injection (data kept, restorable) — `demote` targets global noise |
| `/evolve failures` | aggregated failure classes (gate + benchmark) |
| `/evolve log [tail N] [session <id>]` | plugin log |
| `/evolve export · import <path>` | backup / restore a store |
| `/evolve mount · unmount <skillId>` | hot-mount an executable skill as a live plugin |
| `/evolve goal [objective · done · block]` | round-driven auto-review goal |
| `/evolve benchmark …` | case lifecycle, runs, acceptance |

Model tools: `evolve_list / add / update / delete / rollback`.

Injection shape: prompt notes and delegation specs inject with content (≤6/kind × 180 chars, relevance-ranked). Memories and skills appear as a directory index (`[kind:id] title`, capped at 15 lines with a fold counter) — full text via `evolve_list`. Empty store = zero injected tokens.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseDir` | resolved DSH home | root for the `evolve/` stores |
| `autoReview` | `false` | enable the automatic review gate |
| `reviewIntervalTurns` | `6` | gate cadence on the turn-interval path |
| `maxReviewInputChars` | `40000` | trajectory slice handed to the gate |
| `reviewBudgetTokens` | `4096` | output budget for the gate call |
| `notifyOnAutoReview` | `true` | visible follow-up notice after an applied gate run |
| `requireGlobalApproval` | `true` | global edits ask for explicit approval |
| `localFate` | `true` | gate audits local entries and proposes promote/archive (consulted, never silent) |
| `fateIntervalTurns` | follows `reviewIntervalTurns` | minimum turns between fate assessments |
| `goalBlockedWrapupTurns` | `3` | consecutive blocked-goal gate runs trigger one fate assessment (`0` disables) |
| `promotionBlockPatterns` | POSIX paths, session ids, `~/.dsh` | content matching these is project-scoped and never promoted to global |
| `promotionMinChars` | `100` | whole promotions below this length stay local |
| `injectionDirectoryLines` | `15` | entry-directory lines per build before folding into a counter |
| `sectionOrder` | `118` | system-prompt section order |
| `skillsDir` | `<dshHome>/skills` | where skill entries materialize as SKILL.md bundles |
| `rubricKey` | auto-generated key file | AES-256-GCM passphrase for benchmark rubrics (`DSH_EVOLVE_RUBRIC_KEY` overrides) |
| `logToFile` / `logLevel` / `logMaxBytes` | `true` / `1` / 5 MiB | plugin-owned JSONL file log with rotation |
| `autoRollbackOnReject` | `true` | deterministic rollback after a benchmark rejection |
| `reviewModel` | agent's own | optional cheaper model for the gate (`"provider/model"`) |

Example profile patch:

```yaml
- id: continual-evolve
  config:
    autoReview: true
    reviewIntervalTurns: 6
```

## Development

```bash
pnpm install && pnpm build   # deps + tsc -> lib/
pnpm test                    # vitest (538 tests)
pnpm test:coverage           # v8 coverage, thresholds enforced in CI
pnpm lint                    # oxlint src test
```

Project layout:

```
├── src/                   # engine, tools, commands, gate, fate, benchmark, usage…
├── test/                  # vitest suites (33 files)
├── lib/                   # build output (tsc)
├── docs/
│   ├── design.md          # full design doc (hardening matrix)
│   ├── FAQ.md             # real failure/fix records
│   ├── gap-analysis.md    # vs prime-agent /refine + penguin-harness
│   ├── experiment-bootstrap.md
│   ├── archive/           # closed point-in-time reports
│   └── research/          # penguin report + prime-agent annotated source
├── examples/README.md     # seed benchmark cases
└── .agents/               # AI collaboration layer (AGENTS.md, skills, ADR notes)
```

## Docs & provenance

- Design: [`docs/design.md`](docs/design.md) · Pitfalls: [`docs/FAQ.md`](docs/FAQ.md) · Gap analysis: [`docs/gap-analysis.md`](docs/gap-analysis.md) · D2 experiment: [`docs/experiment-bootstrap.md`](docs/experiment-bootstrap.md)
- Lineage: **penguin-harness** (concept; Apache-2.0) — report in [`docs/research/penguin-harness-self-evolution.md`](docs/research/penguin-harness-self-evolution.md); **prime-agent `/refine`** (engineering shape; MIT) — annotated reference source in [`docs/research/prime-agent-refinement.ts`](docs/research/prime-agent-refinement.ts). This package is an original implementation on the DSH plugin surface.

## License

[MIT](LICENSE)
