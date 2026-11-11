---
name: diagnose
description: "Find the root cause of a bug, failing or flaky test, crash, or performance regression, then fix it with a regression test. Use when the user says 'diagnose', 'debug this', 'why is this failing', 'this test is flaky', or reports something broken, throwing, or slow whose cause is not obvious at a glance. Produces the root cause with evidence, a repro command that goes from red to green, the fix, and a regression test."
argument-hint: "[symptom, error, failing test, or issue URL or number]"
user-invocable: true
---

# Diagnose

Find out why something is broken before you change it. Everything rests on one command that fails on this bug. Build that command first. Theories come after.

If the cause is plain from the input and the fix is one line, skip the ceremony: Fix it and prove it with a repro. Use this loop when the cause is not obvious, or a first fix did not hold.

Redact secrets in every command and output you show. Keep credentials in environment variables, and write `<REDACTED>` in place of tokens, cookies, and auth headers.

## 1. Build the loop

Before you read code to form a theory, get one command that is:

- **Red-capable:** It drives the real code path and checks the user's exact symptom, not "did not crash".
- **Deterministic:** Same verdict every run. For a flaky bug, a high and stable failure rate.
- **Fast:** Seconds, not minutes.
- **Agent-runnable:** It runs without a human.

Ways to get one, roughly in order:

1. A failing test at the seam that reaches the bug.
2. A script that calls the CLI, HTTP endpoint, or dev server with a fixture input.
3. A headless browser or UI-driver script that checks the DOM, console, or network.
4. A captured payload, trace, or log replayed through the code path.
5. A throwaway harness that calls the function directly with minimal dependencies.
6. A fuzz loop over random inputs, for "sometimes wrong".
7. `git bisect run <loop>`, when a known-good commit exists.
8. A differential run: The same input through the old and new version, or two configs.
9. Last resort: A script that prompts the human for each manual step and captures the answer.

**In microsoft/vscode,** list the repository's `.github/skills/` and drive the loop with the matching skill when one exists, for example `unit-tests` for a focused unit run, `validate-ui-scenario` for workbench UI behavior, `smoke-tests` or `flaky-smoke-tests` for smoke failures, and `fix-ci-failures` for a red build. Read the skill first. Do not assume names or flags from memory.

Run the command and paste it with its red output. Then tighten it: Narrow the scope and skip unrelated setup to make it faster, assert the specific symptom, and pin time, seeds, the file system, and the network.

If you cannot build a loop, stop. Say what you tried and [ask the user](../../docs/harnesses.md#asking-the-user) for one of: Access to an environment that reproduces it, a redacted artifact (log, trace, screen recording), or permission to add temporary instrumentation. No loop, no hypotheses.

### Flaky tests

- **Raise the failure rate** instead of waiting for a clean repro. Run the test 50 to 100 times, in parallel, under CPU load. A 50% flake is debuggable. A 1% flake is not yet.
- **Replace guessed delays.** A fixed sleep before a check is a race. Wait for the actual condition (the event fired, the state is reached, the element is visible) with a timeout and a clear message. Keep a fixed delay only when the test is about timing itself, such as a debounce, and comment why that number.
- **Find the polluter.** When a test passes alone but fails in the suite, an earlier test leaks state: A file, a global, a registered listener, an undisposed object. Run the tests before it in halves, checking for the leak after each half, until one test remains.

## 2. Reproduce and minimize

Confirm the loop shows the symptom the user reported, not a different failure nearby. Record the exact error, output, or timing.

Then cut inputs, config, callers, and steps one at a time, rerunning after each cut. Stop when every remaining piece is needed: Removing any one turns the loop green. The minimal repro becomes the regression test.

## 3. Hypothesize

Write 3 to 5 ranked hypotheses before you test any. Read recent history on the area (`git log -p -- <paths>`) while you rank them. Each one must be falsifiable:

> If <X> is the cause, then <changing Y> makes the bug disappear.

A hypothesis without a prediction is a hunch. Sharpen it or drop it. Show the ranked list to the user, since they may know which one to try first. Do not wait for an answer if they are away.

## 4. Probe

- Each probe tests one prediction. Change one variable at a time.
- Prefer a debugger or breakpoint over logs. Put logs only at the boundaries that separate hypotheses.
- Tag every temporary log with one tag for this session, such as `[DEBUG-7f3a]`, so `git grep -n "DEBUG-7f3a"` finds every one.
- For performance, measure a baseline first (a timer, a CPU profile, a heap snapshot, or the repository's profiling skills), then bisect. Logs are the wrong tool for speed.

Before you fix anything, write the causal chain from trigger to symptom, each step with `path:line`. "Somehow X leads to Y" is a gap, so keep probing. If you are stuck, ask the user whether to proceed on the best remaining hypothesis.

## 5. Fix with a regression test

1. **Find the seam.** A good seam exercises the bug the way it happens at the real call site. If the only test you could write is too shallow to reproduce it, do not write one that gives false confidence. Report the missing seam as a finding.
2. **Write the test** from the minimal repro and watch it fail for the right reason.
3. **Fix the root cause,** not the place the symptom shows up. Make one change, with no drive-by refactors.
4. **Watch it pass.** Rerun the original, unminimized loop and the focused tests around the change.

A **divergent fix** reverses a deliberate contract: A test that asserts the current behavior on purpose, a documented default, or a product decision. Do not edit that test to make it pass. Stop and ask the user. A fix that restores the intended behavior can proceed.

After three failed fixes, stop. When each fix uncovers a new problem somewhere else, the design is the problem, not the next patch. Report what each attempt showed and ask the user whether to rethink the approach.

## 6. Clean up

- `git grep -n "DEBUG-<tag>"` returns nothing.
- Scratch harnesses are deleted, or kept outside the repository.
- The loop, the regression test, and the focused tests are green.

## Report

```
Root cause: <one sentence>
Chain: <trigger> -> <step, path:line> -> ... -> <symptom>
Repro: <command>   red before the fix, green after
Fix: <what changed, path:line>
Regression test: <path and test name> | no good seam: <why>
Ruled out: <hypothesis> (<evidence>), ...
Cleanup: [DEBUG-<tag>] removed, scratch files deleted
```

Do not commit or push unless the user asks. To take the fix to a PR, follow [ship](../ship/SKILL.md). When [babysit](../babysit/SKILL.md) hits a CI failure with no obvious cause, run this loop on it.
