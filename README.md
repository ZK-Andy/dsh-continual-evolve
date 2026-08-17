# dsh-continual-evolve

[中文](README.zh.md) | English

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm](https://img.shields.io/npm/v/dsh-continual-evolve)](https://www.npmjs.com/package/dsh-continual-evolve)
[![CI](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml/badge.svg)](https://github.com/ZK-Andy/dsh-continual-evolve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](package.json)
[![Tests](https://img.shields.io/badge/tests-396%20passing-brightgreen)]()
[![Status](https://img.shields.io/badge/status-all%20phases%20complete%20%C2%B7%20maintenance-ff69b4)]()

Continual self-evolution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a versioned, auditable, rollback-safe layer of harness state — prompt notes, memories, skills, and subagent specs — refined from session trajectories.

> **Status: all phases complete; in long-term maintenance.** Phases 1–3
> shipped the full evolution loop: the pure-core engine, model tools and
> the `/evolve` command, the automatic review gate (turn-interval +
> compaction checkpoints, human approval for global edits), real
> system-prompt injection (prompt notes + delegation specs, zero token
> cost when empty), and the benchmark-driven validation loop (code-owned
> scoring, non-regressive acceptance, rubric ACL). Since then the plugin
> keeps growing with usage-driven enhancements — the memory layer (ranked
> injection, trajectory citations, archive), per-installation rubric keys,
> plugin-owned file logging, the session wrap-up (`/evolve wrapup`), and
> the gate's automatic local-fate dimension (local entries get a promoted
> or archived exit on the gate's own cadence — consulted first, never
> written silently). See the Roadmap for the full shipped and candidate
> lists.

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
├── package.json          # exports / files / engines / scripts + dsh.bundle manifest
├── cordis.patch.yml      # bundle patch (dsh plugin add activates on install)
├── tsconfig.json / .oxlintrc.json / .editorconfig / .gitignore
├── LICENSE / README.md / README.zh.md
├── docs/
│   ├── design.md               # full design doc (incl. hardening matrix)
│   └── research/               # penguin-harness report + prime-agent reference source
├── src/
│   ├── index.ts          # cordis plugin entry (service mount + wiring)
│   ├── types.ts          # HarnessState / entry / edit / result types
│   ├── state.ts          # atomic persistence, corrupt degrade, merge, concurrency
│   ├── validate.ts       # code-enforced edit validation
│   ├── apply.ts          # per-edit apply pass with optimistic locking
│   ├── rollback.ts       # deterministic inverse-op rollback
│   ├── plan.ts           # proposal JSON parsing (truncation-aware)
│   ├── tool.ts           # evolve_* model-facing tools (5)
│   ├── command.ts        # /evolve command dispatcher + shared utilities
│   ├── goal-command.ts   # /evolve goal subcommand handler
│   ├── mount-command.ts  # /evolve mount + unmount subcommand handlers
│   ├── benchmark-command.ts # /evolve benchmark subcommand handler
│   ├── wrapup-command.ts # /evolve wrapup subcommand handler
│   ├── planner.ts        # ctx.llm planner
│   ├── llm-text.ts       # unified streaming-text helper (BlockAssembler + finish check)
│   ├── render.ts         # bounded prompt rendering
│   ├── inject.ts         # dynamic system-prompt section (prompt notes + delegation specs, ranked injection)
│   ├── source.ts         # trajectory citations (sessionId + event seqs of distilled entries)
│   ├── auto.ts           # auto-review gate (turn/compaction triggers + audit, global-aware view, local-fate phase)
│   ├── fate.ts           # gate local-fate dimension — auto promote/archive of local entries (consulted first, cooldown)
│   ├── notify.ts         # gate visibility — follow-up notice after an approved auto-refine
│   ├── goal.ts           # goal-driven evolution rounds (/evolve goal)
│   ├── review.ts         # gate LLM judgment (declines local duplicates of globally covered topics)
│   ├── approval.ts       # human approval for global edits
│   ├── skill.ts          # skill materialization ($DSH_HOME/skills/)
│   ├── skill-render.ts   # shared skill rendering (skillNameOf + renderSkillMarkdown, breaks circular dependency)
│   ├── skillquality.ts   # skill standard in the loop (skill-creator template reading + frontmatter code checks)
│   ├── mount.ts          # hot-mounted skill plugins (loader.create + boot restore)
│   ├── benchmark.ts      # benchmark store + CellScore types (with runtime evidence fields)
│   ├── rubric.ts         # rubric ACL (AES-256-GCM envelopes, auto-generated local key)
│   ├── logfile.ts        # plugin-owned file logging (JSONL exporter + rotation)
│   ├── score.ts          # code-owned aggregation + acceptance rule
│   ├── evaluate.ts       # two-stage evaluation runner (executor evidence → independent reviewer) + failure-cell protocol + runtime verification
│   ├── pool.ts           # bounded-concurrency worker pool for evaluation runs
│   ├── store.ts          # store layout + snapshots + result history
│   ├── service.ts        # evolution engine (onApplied hook)
│   ├── usage.ts          # entry injection usage tracking (durable counts, staleness detection)
│   ├── failures.ts       # failure-signature aggregation (gate + benchmark failures by class, /evolve failures)
│   └── wrapup.ts         # session wrap-up lifecycle (promote / split-promote → global, guarded archive; shared proposal builders; staleness signal)
└── test/                 # 28 files, 396 tests
```

## Install

```bash
# from npm (installs and activates — ships its own bundle patch)
dsh plugin --profile web add dsh-continual-evolve

# or from source (first GitHub installs require approving the allowBuilds build step)
dsh plugin --profile web add github:ZK-Andy/dsh-continual-evolve
```

Swap `web` for your profile name (`headless`, or a custom profile).

## In-session usage (after restart)

```
/evolve                  help + current local store
/evolve list [global]    list entries
/evolve history          applied refinements (ids for rollback)
/evolve rollback <id>    deterministically revert a refinement
/evolve plan [msg]       LLM planner against the current store
/evolve wrapup           assess this session's local entries: promote reusable ones to the
                         global store (approval required), archive session-specific ones
/evolve archive <id>     hide an entry from injection (data kept, restorable)
/evolve unarchive <id>   restore an archived entry
/evolve log [tail N] [session <id>]  show the recent plugin log (default 50 lines; optional per-session filter)
/evolve failures                  aggregated failure counts (review-gate + benchmark, by class — D1 observation layer)
/evolve export <path>    backup the local store to JSON
/evolve import <path>    restore a store from an export file
/evolve mount <skillId>  hot-mount a skill entry as a live cordis plugin (tool: skill_<name>)
/evolve mount list       list hot-mounted plugins (restored on boot)
/evolve unmount <id>     remove a hot-mounted plugin
/evolve goal             show the evolution goal (round-driven auto-review)
/evolve goal <objective> create/update the evolution goal — while active, the review gate runs EVERY round
/evolve goal done        complete the evolution goal
```

Model-facing tools: `evolve_list`, `evolve_add`, `evolve_update`, `evolve_delete`, `evolve_rollback`.

## Memory layer

Beyond the persisted store itself, four features keep injected memory
"understanding you" as entries grow (gap analysis vs. Mem0 / Letta / Zep /
LangMem; no external services — everything is pure functions):

- **Ranked injection** — when a kind holds more than the 6-entry cap, the
  injected block no longer shows the fixed first six: entries are scored by
  relevance to the agent's most recent direct user messages (keyword/BM25
  level: title hits weigh 2×) and then by recency (`updated_at`, 30-day
  half-life), so the freshest *and most relevant* entries fill the cap. The
  empty-store zero-token behavior is unchanged.
- **Trajectory citations** — every newly created entry records
  `metadata.sourceSession` + `metadata.sourceSeqs` pointing at the direct
  user messages it was distilled from (DSH sessions are event-sourced with
  contiguous seqs, so the citation expands back into the durable session
  log). Listings show `src=<sessionId>:<seqs>`; old entries are not migrated
  and never error.
- **Archive** — `/evolve archive <id>` hides an entry from injection
  (`metadata.archivedAt`, data kept, rollback-compatible) and
  `/evolve unarchive <id>` restores it. Archived entries are marked
  `[archived]` in `evolve_list` and skipped by injection; the overflow count
  excludes them.
- **Session wrap-up** — a session's local entries otherwise become orphans when
  it ends (later sessions never see them). `/evolve wrapup` gives them an exit.
  Each entry is audited mechanically — global-coverage is judged by **title
  similarity only** (a bare id collision with a different title is intentionally
  NOT coverage; the actual matching global titles are shown to the assessor so
  it judges against real content) — then classified as `promote` / `archive` /
  `keep`. Promotions move reusable entries into the global store **through the
  human approval gate**, keeping their trajectory citation and adding a
  `sourcedFromLocal=<session>:<id>` back-link; the local copy is stamped
  `promotedTo` and retired from injection so it is never offered again.
  **Split promotion** (A-form): a mixed entry (durable facts + session snapshot)
  can be archived while carrying a cleaned `promote` sub-object — only the
  durable part lands globally, the snapshot stays in the archive. A **symmetric
  archive guard** requires user confirmation before an archive that is NOT
  globally covered AND was distilled from real user messages hides that content
  from future sessions (over-archiving gets the same protection as
  over-writing); operational entries still archive silently. Everything stays
  snapshot/versioned/rollbackable.
- **Gate local-fate (automatic wrap-up)** — the same wrap-up machinery now
  runs inside the auto-review gate on its own cadence (`fateIntervalTurns`),
  so local entries get their exit while the session is still running instead
  of waiting for a manual `/evolve wrapup`. On each due gate run the audited
  candidates are classified by the assessor and partitioned by the same
  deterministic guards; the user is consulted FIRST before anything governed
  lands (one dialog covering promotes, split promotions and review-required
  archives — the consultSkillEdits pattern, with a decline cooldown). Covered
  or operational entries still archive silently, and at compaction the gate
  never opens a dialog: only silent archives apply, governed actions are
  deferred with an audit record pointing at `/evolve wrapup`. Every fate
  decision lands in `reviews.jsonl` (`approved` / `declined` / `deferred` /
  `assessed` / `failed`) and applied actions are visible via a follow-up
  notice. Apply writes are byte-identical to the wrap-up command (shared
  proposal builders).
- **Global-aware gate** — the auto-review gate and planner judge the merged
  global + local state with every entry's real scope labeled, so a topic
  already covered by a global entry is declined instead of being re-sedimented
  as a local duplicate.

## Skill standard in the loop

The planner and the auto-review gate are raw `ctx.llm` calls — they do not
live in an agent session, so they cannot load skills through the `skill`
tool. To keep self-evolved skills on the quality bar, the plugin references
the **skill-creator** / **skill-audit** skills (user-level skills distilled
by the author from the official deepseek-harness 11 skills; template facts
verified against deepseek-harness `47f9438`) at runtime — they stay the
single source of truth on disk, nothing is copied:

- Every planning call receives a `<skill_quality_standard>` block: the
  `skill-creator/references/template.md` facts when those skills are
  installed (`<dshHome>/skills/`), or a builtin distilled guide otherwise
  (~1KB, low-frequency calls). The planner must ground skill proposals in a
  REAL trigger scenario from the trajectory, must not duplicate the
  official 11 skills or existing entries, and self-checks every proposed
  skill against the 7 structural features.
- The gate judges skill-related trajectories against the skill-audit
  dimensions (frontmatter routing, structural features, paragraph skeleton,
  duplication) and declines proposals that would not meet the standard.
- The mechanical frontmatter rules of `validate-frontmatter.mjs` are
  code-enforced at apply time: skill bodies must not open with a second
  `---` block (it would shadow the generated frontmatter), and resource
  references may not escape the skill directory. After materialization the
  rendered SKILL.md is re-checked and dangling `references/`/`scripts/`
  links are logged as warnings.
- **Two skill forms** — `executable` skills keep the python reference
  contract (hot-mountable as tools); `guidance` skills are SKILL.md
  documents with no reference, the form for recurring multi-step workflows
  (session start/end routines, handoff procedures). Code enforces the
  split: a guidance skill must NOT carry a reference or arguments contract.
- **User-governed skill creation** — the gate never writes a skill
  silently: when the planner proposes skill edits, the user is asked
  (固化/不固化) before they land; a rejected candidate is not offered
  again within a cooldown window. The rest of a proposal proceeds
  regardless, so memory/prompt distillation is never blocked by a skill
  decision.

## Logging

Plugin-owned file logging: every cordis log message (from this plugin or any
other) is appended to `<dshHome>/evolve/plugin.log` as JSONL (0600, rotated to
`plugin.log.1` past `logMaxBytes`). It works no matter how `dsh web` is
launched — no extra component to install, no startup-script dependency.
View the tail with `/evolve log [tail N]`, or read the file directly:

```bash
tail -f ~/.dsh/evolve/plugin.log          # live
/evolve log 100                            # last 100 lines in the chat
```

For live output in a foreground terminal, the official
`@deepseek-ai/cordis-plugin-logger-console` plugin can be added to the
profile (optional; the file log remains the baseline that always exists).

## Benchmark-driven validation (Phase 3)

```
/evolve benchmark new <title> [runs]                   create a benchmark (runs = repeats per case, default 1)
/evolve benchmark add-case <bid> <title> <statement> <rubric>
/evolve benchmark list                                 list benchmarks
/evolve benchmark reset <bid>                          clear the scoreboard (re-run reference)
/evolve benchmark status <bid>                         scoreboard + decisions
/evolve benchmark run <bid>                            evaluate current state → reference
/evolve benchmark run <bid> candidate <refinementId>   evaluate post-refinement state → decide
/evolve benchmark casecheck <bid>                      quality-gate check all cases
/evolve benchmark pilot <bid> <cid>                    single pilot run for calibration
/evolve benchmark freeze <bid> <cid>                   freeze a case as formal baseline
/evolve benchmark meta <bid> <cid> <field> <value>     set case metadata (capability/distinguisher/shortcuts)
```

The loop: freeze a reference score → evolve a candidate (`/evolve plan`) →
run the same case × run matrix against the post-refinement state → the
**code-owned** acceptance rule keeps the candidate only if the overall mean
strictly improves with no case regressing (Self-Harness style).

**Evaluator/scorer separation (two-stage, gap A1)** — each case × run unit
is a PAIR of fresh subagents:

1. the **executor** performs the task with its tools and records **concrete
   evidence** of what it did and found — it NEVER sees the rubric, so the
   agent under test cannot optimize toward or self-grade against the grading
   criteria;
2. an **independent reviewer** grades that evidence strictly against the
   rubric (the only branch that receives the decrypted rubric), eliminating
   the "self-produced and self-scored" bias.

Each cell records the executor's session id, so a score can be drilled back
to the exact transcript that produced it (trace evidence pointer, gap A4).

**Failure-cell protocol (gap A2)** — a unit that cannot produce a score
(rubric decrypt error, executor/reviewer crash, protocol error) is recorded
as a **failed** cell, NEVER a zero: aggregation excludes failed cells from
every mean and counts them (`/evolve benchmark status` shows `(N failed)`),
and the acceptance rule rejects a round with more failed cells than
`maxFailedCells` (0 by default) instead of silently averaging a 0 into the
mean.

Aggregation and decisions live in `src/score.ts`. Rubric isolation is by
construction (the planner never sees rubric files, and the executor branch
never decrypts); a rejection is recorded in the scoreboard and the
refinement is rolled back automatically (`autoRollbackOnReject`, on by
default).

Ready-to-use seed cases are in [`examples/`](examples/) — copy-paste the
statement and rubric to get started in under a minute.

### Real recorded run (ACCEPT)

A live `dsh web` session, one case, one candidate — the first genuine
acceptance:

| Step | Command | Outcome |
|---|---|---|
| reference | `/evolve benchmark run lint_convention` | **90** — the evaluator agent actually grepped the harness store and reported *"lint/ruff/eslint/mypy appear in zero entries"* |
| candidate | `/evolve plan 记住：写代码前必须先运行适用的 lint 检查` | creates `memory:convention_lint_before_code` |
| re-evaluate | `/evolve benchmark run lint_convention candidate <id>` | **100** — evaluator ran `evolve_list`, hit the memory, quoted it verbatim |
| decision | — | `overall: 90 → 100` · `lint_knowledge: 90 → 100` · **DECISION: ACCEPTED** |

The executor does not grade model common sense — it inspects the actual
harness state under test (grep, `evolve_list`) and records what it found;
the independent reviewer grades that record. A harness change measurably
moves the score. Earlier runs in the same session
produced honest `REJECTED` decisions (0 → 0 stub cases, and 100 → 100
where the baseline was already perfect).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseDir` | resolved DSH home | root for the `evolve/` stores |
| `sectionOrder` | 118 | system-prompt section order |
| `autoReview` | `false` | enable the automatic review gate (costs a cheap model call per interval) |
| `reviewIntervalTurns` | 6 | gate runs when this many turns passed since the last review |
| `maxReviewInputChars` | 40000 | trajectory slice handed to the gate |
| `reviewBudgetTokens` | 4096 | output budget for the gate call |
| `notifyOnAutoReview` | `true` | after an approved gate run that applied edits, queue a visible follow-up notice in the session (persisted entries + rollback command) |
| `requireGlobalApproval` | `true` | cross-session (global) edits ask the user for "批准" before applying |
| `skillsDir` | `<dshHome>/skills` | root where skill entries materialize as SKILL.md bundles |
| `rubricKey` | auto-generated local key file (`<dshHome>/evolve/rubric.key`, 0600) → dev fallback | passphrase for AES-256-GCM rubric encryption (benchmark rubrics never touch the disk in plaintext). When unset, the plugin generates a random per-installation key file on first use — every install gets its own key, no setup needed; `DSH_EVOLVE_RUBRIC_KEY` is the environment-variable override |
| `logToFile` | `true` | write all cordis log messages to `<dshHome>/evolve/plugin.log` (JSONL, 0600) — plugin-owned logging works with any launch method, no extra component to install |
| `logLevel` | `1` | file log level: 0=error, 1=info, 2=warn, 3=debug |
| `logMaxBytes` | 5 MiB | rotate the log to `plugin.log.1` when it exceeds this size |
| `autoRollbackOnReject` | `true` | after a benchmark decision rejects a candidate, roll the refinement back automatically (same engine path as `/evolve rollback` — deterministic, snapshotted, audited) |
| `localFate` | `true` | gate local-fate dimension: the gate audits the session's local entries on its own cadence and proposes promote/archive — consulted first, never written silently (only meaningful with `autoReview`) |
| `fateIntervalTurns` | follows `reviewIntervalTurns` | minimum turns between local-fate assessments on the turn-interval path (compaction is unconditional) |
| `goalBlockedWrapupTurns` | `3` | D3: after this many consecutive gate runs observing the goal phase `blocked`, run one local-fate assessment (`0` disables) |
| `reviewModel` | (agent's own) | optional model override for the review gate (cheaper model); format: `"provider/model"` or just `"model"` |

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
pnpm dev            # tsc --watch
pnpm build          # tsc -> lib/
pnpm test           # vitest run
pnpm lint           # oxlint src test
```

Hit a wall? See [`docs/FAQ.md`](docs/FAQ.md) — real failure/fix records (service planes, schema DSL, structured output, gate counting, verifying prompt injection).

Where we still lag behind prime-agent `/refine` and penguin-harness — and what to build next: [`docs/gap-analysis.md`](docs/gap-analysis.md) (P0+P1+P2+P3 shipped: evaluator/scorer separation, failure-cell protocol, runtime provenance verification + material-drift detection, usage statistics, auto-decay, case lifecycle + quality gate, entry directory view, review model separation, blast-radius annotations, duration tracking, evolve_complete events, seed benchmark; D1 observation layer + D3 goal-blocked trigger shipped; remaining: cross-process sync on demand + D1/D2 full engineering pending experiment data).

## Roadmap

**Shipped**

- **Phases 1–3 (done)**: pure-core engine (state model, validation, apply, rollback, proposal parsing) → `evolve_*` tools + `/evolve` command + `ctx.llm` planner → auto-refine review gate (turn-interval + compaction checkpoints, visible follow-up notices), global-scope human approval, executable skills, real system-prompt injection (prompt notes + delegation specs, inherited by subagents), benchmark-driven validation loop (code-owned scoreboard, non-regressive acceptance, rubric isolation by construction), hot-mounted skill plugins, goal-driven evolution rounds.
- **2026-08 maintenance wave (done)**:
  - **memory layer** — ranked injection (relevance + recency scoring fills the per-kind cap), trajectory citations (`metadata.sourceSession` + `sourceSeqs`, shown as `src=session:seqs`), archive/unarchive (`/evolve archive <id>`, injection skips archived entries), global-aware gate (declines local duplicates of globally covered topics)
  - **per-installation rubric key** — auto-generated local key file (`<dshHome>/evolve/rubric.key`, 0600); no more publicly known dev key
  - **plugin-owned file logging** — every cordis log message lands in `<dshHome>/evolve/plugin.log` (JSONL, 0600, rotated), viewable via `/evolve log`; works with any launch method, no extra component to install
  - **trajectory-grounded planning** — `/evolve plan` (and every planner call, including the gate's refine step) now reads the session trajectory: the caller's recent direct user messages are extracted from the session log and fed to the planner as a `<session_trajectory>` block, so proposals are grounded in what the user actually said (explicit `trajectory` overrides; empty trajectory is omitted at zero cost)
  - **gate-proposed archiving** — stale entries are a first-class refine target: the planner can emit `action: "archive"` (kind + id only), which stamps `metadata.archivedAt` through the normal apply path — snapshot, version bump, audit event, and a deterministic rollback inverse that restores the pre-archive state. Archive hides from injection but never deletes; re-archiving an archived entry is rejected, and the base system prompt stays immutable
  - **automatic rollback on benchmark rejection** — the acceptance loop is closed: when the code-owned decision rejects a candidate, the refinement is reverted automatically through the same engine path as `/evolve rollback` (deterministic inverse edits, snapshotted and audited; configurable via `autoRollbackOnReject`, on by default). Failures report the manual fallback instead of throwing
  - **per-session log filtering** — `/evolve log [tail N] [session <id>]` keeps only the lines mentioning a given session id (exact token match, drawn from the rendered message and raw args); gate records now carry the session id in their log line
  - **skill standard in the loop** — the planner and gate now author and judge skill entries against the skill-creator/skill-audit standard (author-distilled from the official deepseek-harness 11 skills): every plan call injects the `template.md` facts (builtin distilled guide as fallback) as `<skill_quality_standard>`; apply code-enforces the frontmatter mechanics (no shadowing `---`, no escaping resource refs); materialized SKILL.md files are re-checked and dangling resource references are logged;
  - **guidance skills + user-governed creation** — a second skill form (SKILL.md documents without a python reference) lets recurring workflows be proposed as skills; the gate offers every auto-created skill to the user (固化/不固化) before it lands, with a rejection cooldown — skills grow under governance, never silently
- **2026-08-17 wrap-up wave (done)**:
  - **`/evolve wrapup`** — a session's local entries get a real exit at session end: mechanical audit (local candidates + global-coverage detection; coverage judges **title similarity only** — a bare id collision with a different title is deliberately NOT coverage, and the real matching global titles are shown to the assessor) → LLM classification (`promote` / `archive` / `keep` + A-form split promotion: archive a mixed entry while promoting a cleaned durable sub-object) → deterministic guards re-checked at apply time (promote can never write a global duplicate; the symmetric archive guard requires user confirmation before an uncovered, user-sourced archive hides content; splits that duplicate a global topic drop to plain archive) → one human approval gate for every global create
  - **gate local-fate dimension** — the wrap-up machinery now runs inside the auto-review gate on its own cadence (`fateIntervalTurns`, compaction unconditional): local entries are audited, classified and partitioned while the session is still running; governed actions are consulted first (one dialog, decline cooldown), covered/operational entries archive silently, compaction applies only silent archives and defers governed actions with an audit record; every decision lands in `reviews.jsonl` and applied actions get a follow-up notice. Apply writes are shared with the wrap-up command (byte-identical proposals)
- **2026-08-19 research-wave precursors (done)**:
  - **goal-blocked wrap-up (D3)** — a goal stuck in `blocked` for `goalBlockedWrapupTurns` consecutive gate runs (default 3) triggers one local-fate assessment, so the blocked encounter is distilled before the session moves on; the streak resets on any non-blocked run and after each assessment, and declined proposals follow the normal fate cooldown (never nagged). Disable with `goalBlockedWrapupTurns: 0`
  - **failure-signature aggregation (D1 observation layer)** — `/evolve failures` counts every failed review-gate record and benchmark failed cell by deterministic failure class (`rubric-decrypt` / `executor` / `reviewer` / `material-drift` / `gate` / `max-tokens` / …), the data layer a future failure-signature Refiner would route on
  - **bootstrap-update experiment scaffold (D2)** — [`docs/experiment-bootstrap.md`](docs/experiment-bootstrap.md) designs a ≤3-round controlled experiment (fixed reference → evolve harness → candidate) to test whether a refined harness accelerates the next run; `scripts/benchmark-trend.sh` extracts the per-run trend table (overall / totalDurationMs / failed / case-hash consistency) from scoreboards
- **2026-08-17 gap P0 (done)**:
  - **evaluator/scorer separation** — benchmark evaluation is now two-stage (gap A1): the executor performs the task and records concrete evidence without ever seeing the rubric; an independent reviewer grades that evidence against the rubric (the only branch that decrypts it). The assessed agent can no longer optimize toward or self-grade against the criteria.
  - **failure-cell protocol** — cells carry `status: ok|failed` (gap A2): failed units are excluded from every mean and counted, and the acceptance rule rejects rounds with failures beyond `maxFailedCells` (0 default) instead of averaging a zero into the mean. Scoreboard status/run surfaces failed counts and per-cell reasons.
  - **trace evidence pointer** — each cell records the executor's session id (gap A4), so a score drills back to the exact transcript that earned it
- **2026-08-18 gap P1 (done)**:
  - **runtime evidence verification (A3)** — cells now record actual `provider`, `model`, and `caseHash` (SHA-256 prefix of statement + rubric) written by the host, not the model; material changes between reference and candidate runs are detected and re-mark the affected candidate cells as failed (version_changed semantics, `score.flagMaterialDrift`), so a drifted round can never be accepted
  - **entry usage statistics (B1)** — injection counts are durably tracked per entry in `<baseDir>/evolve/usage.json`; `evolve_list` shows usage counts; `zeroUsageEntries()` surfaces never-injected local entries as archive candidates
  - **automatic staleness detection (B2)** — entries with zero injection usage AND old recency are flagged `stale` in wrap-up candidates; the LLM assessor is instructed to prefer "archive" for stale entries
- **2026-08-18 gap P2 (done)**:
  - **case lifecycle + quality gate (A5)** — cases follow a `draft → calibrating → frozen` state machine; `casecheck` runs mechanical quality validation (capability contract, distinguisher, shortcuts); `pilot` performs a single-run calibration; `freeze` locks a case as a formal baseline (requires quality gate pass); `meta` sets case metadata fields
  - **entry directory view (B3)** — the injection block now includes a lightweight directory of ALL non-archived entries (id + title, one line each) when entries exceed the curated cap, giving the model a zero-cost overview
  - **review model separation (C1)** — `reviewModel` config option lets the review gate use a cheaper model than the main agent
  - **blast-radius annotations (C2)** — every edit now carries a `blastRadius` field (`general` / `project` / `session`); the planner is instructed to annotate it and the parser validates values
  - **duration tracking (C3)** — each evaluation cell records `durationMs` (wall-clock time); aggregate totals and decision reports show timing comparison
- **2026-08-18 code refactoring (done)**:
  - **circular dependency break (P1-1)** — extracted `skill-render.ts` to decouple `skill.ts ↔ skillquality.ts`
  - **LLM call deduplication (P1-2)** — extracted `llm-text.ts` with shared `streamText()` (~107 lines removed from review/planner/wrapup)
  - **config type derivation (P2-1)** — `EvolveConfig` now derived from schemastery schema via `Schemastery.TypeT` (eliminated 20-line handwritten interface)
  - **command.ts split (P2-2)** — 860-line god file split into `goal-command.ts`, `mount-command.ts`, `benchmark-command.ts`, `wrapup-command.ts`
  - **P3 cleanups** — `questionServiceOf()` cast dedup (4 sites), dead exports removed, contradictory comments fixed

The upcoming/candidates list is empty for now — future work is driven by real usage.

## License

MIT. Independent project — not affiliated with DeepSeek.
