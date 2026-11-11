---
name: trim
description: "Use when the user says 'trim', 'trim this', 'is this bloated', 'simplify this diff', or worries that a change is far bigger than it needs to be. Finds speculative abstractions, pass-through layers, reimplemented helpers, defensive noise, and test bloat, and cuts the change toward its smallest correct version."
argument-hint: "[report] [paths] [--base <ref>]"
user-invocable: true
---

# Trim

Shrink the current change to the smallest version that fully meets its goal. A fresh reviewer finds the cuts, you check each one, and then you apply the ones that hold up.

Use a separate reviewer because the agent that wrote the code tends to defend it.

## Scope

- Default: The branch diff from its merge base through the working tree, including untracked files. Use the paths the user names instead, if any.
- `report`: Report the findings and change nothing.
- `<skill-dir>` below means the absolute path of the directory containing this SKILL.md. `<preflight-state>` is `node <skill-dir>/../preflight/scripts/preflight-state.mjs`.

## Steps

1. **Frame it.** State the goal in one or two sentences from the session, the linked issue, or the PR. Run `<preflight-state> size` and keep its output.
2. **Review.** Launch one general-purpose agent ([parallel subagents](../../docs/harnesses.md#parallel-subagents)). Give it the full text of [reviewer.md](reviewer.md), the goal, the base ref, the `size` output, the diff command to run (`git diff <merge-base>` plus `git status --short` for untracked files), and the applicable repository instruction files. Tell it to review the whole change and stay read-only.
3. **Validate.** Check every finding against the code yourself. Confirm the cited helper exists and fits, and confirm the caller count. Drop any finding that would change behavior, move complexity rather than remove it, or make the code harder to read. Downgrade `should` to `nit` when the payoff is small.
4. **Apply.** Unless `report` was given, apply every validated `should` finding, plus `nit` findings that only delete code. For each **significant** cut, ask the user first ([asking the user](../../docs/harnesses.md#asking-the-user)): What goes, why, what could be affected, the simpler replacement, and your recommendation. Prefer deleting over adding, and keep each cut a cut rather than a new abstraction.
5. **Verify.** Run the repository's focused build, type check, and tests for the touched area. If a cut breaks something, fix it the simple way or revert that one cut and say why.
6. **Report.**

```
Trim: +412 -38 -> +201 -38 (prod +290 -> +120)
Applied: trim-1 inline FooAdapter (-64), trim-3 reuse ResourceMap (-41), ...
Declined: trim-2 (changes cancellation behavior), trim-5 (nit, not a pure deletion)
Minimal sketch: <the reviewer's sketch>
Validation: <commands and results>
```

Leave committing, pushing, and posting to the user. Editing the change makes any earlier [preflight](../preflight/SKILL.md) record stale, which is intended.
