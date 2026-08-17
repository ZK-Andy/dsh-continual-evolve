# Seed Benchmark Examples

This directory contains ready-to-use benchmark cases for validating the
`dsh-continual-evolve` plugin. Each example is a self-contained case
definition (statement + rubric) that you can add to any benchmark.

## Quick Start

```bash
# 1. Create a benchmark
/evolve benchmark new lint_convention

# 2. Add the seed case (copy-paste the statement and rubric below)
/evolve benchmark add-case lint_convention "Lint Before Code" \
  "Check if the harness state contains a memory or prompt entry that instructs the agent to run lint checks before writing code. The entry should mention specific lint tools (ruff, eslint, mypy, etc.) or a general 'lint before code' convention." \
  "Score 0-100: 0=no lint-related entry found; 50=generic entry mentioning lint but no specifics; 80=entry names specific tools and is positioned as a behavioral policy; 100=entry is a durable memory/prompt that explicitly requires linting before code changes, cites specific tools, and would survive session boundaries."

# 3. Run the reference evaluation
/evolve benchmark run lint_convention

# 4. Evolve a candidate
/evolve plan "记住：写代码前必须先运行适用的 lint 检查"

# 5. Evaluate the candidate
/evolve benchmark run lint_convention candidate <refinementId>
```

## Case: Lint Before Code

**Statement:**

> Check if the harness state contains a memory or prompt entry that instructs
> the agent to run lint checks before writing code. The entry should mention
> specific lint tools (ruff, eslint, mypy, etc.) or a general "lint before
> code" convention.

**Rubric:**

> Score 0-100:
> - **0**: No lint-related entry found in the harness state.
> - **25**: Vague mention of "code quality" without naming lint tools or
>   processes.
> - **50**: Entry mentions linting but as a suggestion, not a required
>   convention (e.g. "you may want to lint").
> - **75**: Entry names specific lint tools (ruff, eslint, mypy, oxlint,
>   etc.) and is positioned as a behavioral policy the agent should follow.
> - **100**: Entry is a durable memory or prompt that explicitly requires
>   linting before every code change, names specific tools, and is positioned
>   as a cross-session convention (global scope or local with trajectory
>   citation). The entry would survive session boundaries and influence future
>   code-writing behavior.

## How to Use

1. **New users**: Run the Quick Start above to see the full benchmark loop
   in action. This is the simplest way to verify your installation works.

2. **Existing users**: Add the case to an existing benchmark to validate that
   a specific refinement actually moves the score.

3. **Custom cases**: Use the statement/rubric format above as a template.
   Good rubrics are:
   - **Observable**: the evaluator can check the harness state mechanically
   - **Graded**: multiple score levels (not just pass/fail)
   - **Specific**: names what to look for, not vague qualities
   - **Bounded**: clear minimum (0) and maximum (100)
