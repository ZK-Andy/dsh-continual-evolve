# dsh-continual-evolve

[中文](README.zh.md) | English

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-1046%20passing-brightgreen)]()
[![Coverage · statements](https://img.shields.io/badge/coverage_statements-98%25-brightgreen)]()
[![Coverage · branches](https://img.shields.io/badge/coverage_branches-92%25-green)]()
[![Coverage · functions](https://img.shields.io/badge/coverage_functions-99%25-brightgreen)]()

Continual self-evolution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a versioned, auditable, rollback-safe harness state layer — prompt notes, memories, skills, subagent specs — refined from session trajectories.

**The model proposes, the code guarantees.** Every mechanical safety property — schema validation, atomic writes, snapshots, versioning, audit trail, acceptance decisions — is enforced in code, never by prompt discipline.

## Why

Agents accumulate reusable experience (repeated failures, durable facts, reusable procedures) and forget it next session. This plugin turns that experience into first-class state:

- **Three scopes** with merge semantics (global < project < local): **local** per-session staging, **project** per-workspace cross-session store, **global** cross-project — plus mechanical promotion guards so only portable, substantial, non-duplicate knowledge reaches global
- **Typed one-fact memories**: every memory entry carries a recall type (`user | feedback | project | reference`); pitfalls (`feedback`) must include Why + How to apply
- **Dedicated background memory agent**: eligible successful turns feed a bounded ZCode-style loop that searches the frozen memory manifest and proposes memory-only edits through a closed tool set; it cannot call agents, MCP, the network, or write source files. The generic review/planner/fate path is not run by this listener
- **Memory recall, projection, and receipts**: `evolve_recall` reads back full memory content by query/kind/scope/type; every memory apply also materializes a readable `MEMORY.md` index plus one fact file per entry; each extraction lands a unified audit receipt (no-op/applied/declined with duration and turn stats) and only applied outcomes notify the session
- **Deterministic rollback**: inverse edits generated from applied results — no LLM re-guessing
- **Benchmark loop**: candidate refinements are evaluated against frozen cases by a separate scorer before acceptance (rubric encrypted at rest)
- **Store hygiene**: `/evolve consolidate` turns write-time conflict hints and zero-use staleness into one approved, fully reversible batch of archives — with `merge`, near-duplicate content folds into the surviving original

## How it works

1. **Sediment** — the model creates entries via `evolve_add`, or the automatic Memory Agent consumes incremental snapshots after successful turns. Generic review/planner remains manual unless separately invoked.
2. **Capability-aware auxiliary calls** — the memory loop, review, planner, wrapup, and fate resolve exact provider/model metadata through [`src/llm-text.ts`](src/llm-text.ts), use the lowest advertised enabled reasoning effort (falling back to a closing effort only when no enabled level exists), and forward the host session id for provider routing; models without reasoning metadata use their provider default.
3. **Guard** — code-enforced validation: edit schema, blast-radius/scope coherence, and the promotion policy (project-scoped markers, thin content, near-duplicate detection, credential screening keep the global store clean — secrets are rejected at every write sink, including mount materialization). Global creates that near-duplicate an existing entry are rejected at write time (≥0.8 similarity); moderate overlaps carry a `conflictHint` for later consolidation.
4. **Approve** — global and project writes require explicit human approval; the dialog shows the bounded structured edit diff and conflict warnings, while malformed/lost responses remain retryable rather than counting as rejection.
5. **Apply & inject** — memory batches preflight every persistent approval, recheck abort before writes, and compensate earlier scope writes if a later batch fails; every successful scope still passes through snapshot + audit. Prompt notes and delegation specs inject into the system prompt (capped, relevance-ranked, contradicted entries demoted, zero tokens when empty); memories/skills appear as a relevance-ordered capped directory index (`- [memory:type:id] title` hooks, full text one `evolve_list` away).
6. **Validate & roll back** — benchmarks score candidates against frozen cases; rejected candidates roll back deterministically and are captured as draft regression cases (`auto_regression` benchmark).

## Install

```bash
# from npm (installs and activates — ships its own bundle patch)
dsh plugin add dsh-continual-evolve

# or from source (first GitHub installs require approving the allowBuilds step)
dsh plugin add ZK-Andy/dsh-continual-evolve
```

Restart the DSH profile you use (`dsh web` or the desktop host) after installing or updating.

## Usage

Commands (in-session):

| Command | Effect |
|---|---|
| `/evolve` | help + current local store |
| `/evolve list · history · rollback <id>` | inspect and revert (add `project` for this project's store, `global` for the cross-project store) |
| `/evolve plan [msg]` | run the LLM planner against the store |
| `/evolve wrapup` | assess this session's local entries: promote / archive / keep |
| `/evolve archive · unarchive · demote <id>` | hide from injection (data kept, restorable) — `demote` targets global noise |
| `/evolve recall [scope] <query…>` | targeted memory recall: full content with version, source, and staleness |
| `/evolve remember <type> [scope] <text…>` | immediately persist one typed memory (`user|feedback|project|reference`) |
| `/evolve forget [scope] <query…>` | locate one memory and archive it (restorable); ambiguous queries only list |
| `/evolve consolidate [apply] [merge]` | report (or apply) one batch archive of conflict-hinted + stale zero-use global entries; `merge` folds near-duplicate content into the survivors |
| `/evolve failures` | aggregated failure classes (gate + benchmark) |
| `/evolve log [tail N] [session <id>]` | plugin log |
| `/evolve export · import <path>` | backup / restore a store |
| `/evolve mount · unmount <skillId>` | hot-mount an executable skill as a live plugin |
| `/evolve goal [objective · done · block]` | round-driven auto-review goal |
| `/evolve benchmark …` | case lifecycle, runs, acceptance |
| `/evolve pause · resume · status` | pause/resume the auto-review gate (manual tools keep working), gate state |
| `/evolve usage` | per-entry injection counts + exact provider-reported tokens for direct memory/review/planner/wrapup/fate calls (benchmark host subagents excluded) |

Model tools: `evolve_list / add / update / delete / rollback / recall` (`evolve_delete` takes `id` or a batch `ids` array — one refinement, one approval; `evolve_recall` filters by query, kinds, scopes, memory types, and limit, and returns full content with version, source, and staleness).

For third-party consumers: every applied evolution (gate or manual) appends a structured `evolve_complete` event to `reviews.jsonl` (`src/evolve-event.ts` defines the shape) alongside the human-readable audit records.

`/evolve usage` also reads `evolve/token-usage.jsonl`: exact provider-reported input/cache/output/total tokens for the plugin's direct memory-agent, review, planner, manual-wrapup, and automatic-fate calls. The report covers a retained tail rather than lifetime usage, distinguishes missing provider samples, and explicitly excludes host benchmark subagents, their agent-loop calls, and per-entry injection attribution.

Injection shape: prompt notes and delegation specs inject with content (≤6/kind × 180 chars, relevance-ranked). Memories and skills appear as a relevance-ordered directory index (`[memory:type:id] title` hooks, capped at 15 lines with a fold counter) — full text via `evolve_recall` (targeted) or `evolve_list`. Every memory apply also refreshes a readable `MEMORY.md` index plus one fact file per entry in the store directory. Empty store = zero injected tokens.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseDir` | resolved DSH home | root for the `evolve/` stores |
| `autoReview` | `false` | initial Memory Agent default when no `evolve/runtime.json` exists yet; the listener is always registered, so this is not a registration gate |
| `memoryMinUserWords` | `3` | ZCode-style minimum lexical words in one direct user text part; uses CJK-aware segmentation |
| `sessionCloseDrainMs` | `15000` | session-close bounded drain for in-flight extraction in ms (`0` aborts immediately) |
| `reviewIntervalTurns` | `6` | legacy local-fate cadence fallback; successful-turn review no longer waits for this interval |
| `maxReviewInputChars` | `40000` | trajectory slice handed to the gate |
| `reviewBudgetTokens` | `4096` | output budget for the gate call |
| `notifyOnAutoReview` | `true` | visible follow-up notice after an applied gate run |
| `requireGlobalApproval` | `true` | global and project edits ask for explicit approval |
| `localFate` | `false` | optional local-entry promote/archive fate assessment; unreachable while the listener runs memory-only, so it only affects direct/full callers |
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
| `autoCase` | `true` | failed evolution attempts are captured as draft regression cases (`auto_regression` benchmark) |
| `reviewModel` | agent's own | optional cheaper model for the dedicated memory agent and review gate (`"provider/model"`) |
| `plannerPrefixCache` | `auto` | Route A session-prefix input when cache evidence exists (`session` always, `off` legacy flat text) |
| `plannerPrefixMaxChars` | `12000` | session-prefix budget for Route A planning inputs (chars) |
| `historyRetain` | `{snapshots: 20, refinements: 500, reviews: 500, tokenUsage: 500}` | storage hygiene: snapshots per store, tail lines per store history, shared `reviews.jsonl` tail, and direct-call `token-usage.jsonl` tail |

Example profile patch:

```yaml
- id: continual-evolve
  config:
    autoReview: true
    reviewIntervalTurns: 6
```

The Memory Agent listener is registered even when `autoReview` is `false` —
`autoReview` only supplies the initial default, so an install works without
editing the profile. Use `/evolve resume` to enable successful-turn snapshots
immediately, `/evolve pause` to suppress new snapshots and model work, and
`/evolve status` to inspect the configured default plus the current runtime
state. The runtime switch is stored in `evolve/runtime.json`; manual `evolve_*`
tools and `/evolve` commands are not paused. Only the Memory Agent runs
automatically: the generic review/planner, prompt/skill writes, and local-fate
phases are not reachable from this listener. The memory trigger follows ZCode's
lightweight eligibility: direct user text must contain at least
`memoryMinUserWords` lexical words (CJK-aware segmentation), while
empty/internal/direct-memory-write snapshots are skipped; compaction does not
add a separate memory-only trigger. Every extraction writes a unified audit
receipt (`noop`/`applied`/`declined` with duration and turn/search stats) to
`reviews.jsonl`; only applied outcomes queue a visible follow-up, and a
closing session lets in-flight extraction settle up to `sessionCloseDrainMs`
before aborting.

## Development

```bash
pnpm install && pnpm build   # deps + tsc -> lib/
pnpm test                    # vitest (1046 tests)
pnpm test:coverage           # v8 coverage, thresholds enforced in CI
pnpm coverage:gaps           # locate uncovered lines per file (read-only)
pnpm lint                    # oxlint src test
```

Project layout:

```
├── src/                   # engine, tools, commands, memory agent, recall, projection, gate, fate, benchmark, injection + token usage…
├── test/                  # vitest suites (55 files)
├── lib/                   # build output (tsc)
├── docs/
│   ├── design.md          # full design doc (hardening matrix)
│   ├── FAQ.md             # real failure/fix records
│   ├── gap-analysis.md    # vs prime-agent /refine + penguin-harness
│   ├── research/pi-dsh-competitor-gap-analysis.md  # pi/dsh ecosystem competitors
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
