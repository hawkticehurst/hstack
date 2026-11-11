---
name: ship
description: "Use only when the user says 'ship it' or invokes ship explicitly. Takes a change unattended from its current state to a PR that is ready for a human to merge, then stops. Never merges."
argument-hint: "[draft] [deep] [goal or issue]"
user-invocable: true
disable-model-invocation: true
---

# Ship

The user invoked this because they are not watching. They will read your final message long after you stop. You own the work from its current state to a PR that is ready to merge, and you stop there.

## What this grants

- Creating a branch, committing, and pushing this task's branch.
- `git push --force-with-lease` on this task's branch after a rebase.
- Running the product, browser automation, screenshots, and other test methods needed to prove the change, even where repository guidance says to ask first. Rules about *how* to test still apply.

Merging, auto-merge, pushing to the default branch, other branches or PRs, deleting data, and anything outside the repository stay with the user.

## The ledger

Keep a ledger at `$(git rev-parse --git-path hstack)/ship.md`, inside the git directory so it is never committed. If it already exists for this branch, read it first and resume from it instead of redoing finished steps.

Write it at the start and update it after every step:

```
Goal: <the user's goal in their words>
Done when: <the pass/fail check that proves it>
Branch: <branch>   PR: <url or none>
Steps: frame done | change done | proof done | preflight ready (2 rounds) | pr opened | babysit round 3
Ruling: <decision> - <why> - <cost if wrong>
```

Add a `Ruling:` line for every decision you make on the user's behalf. Those lines become the decisions section of your report.

## Steps

1. **Frame.** In your first message, state the goal in your own words, the smallest change you expect to meet it, and the check that will prove it is done: A concrete command, reproduction, or observation with a pass/fail result, not an activity. If you are on the default branch, create a branch that follows the repository's naming convention, for example `<user>/<topic>`.
2. **Finish the change.** Make the smallest change that works. Fix the case that happened, not every case that could. For a bug, follow [diagnose](../diagnose/SKILL.md) to find the root cause first.
3. **Prove it.** Use the most direct evidence the change allows:
   - Reproduce the original failure, apply the fix, and watch the same reproduction pass.
   - Run the focused build, type check, and tests. Read the runner's summary: A run that selected zero tests proves nothing.
   - When the behavior has no test and the repository has a test setup, add one focused test. Prove it can fail: Revert the fix, watch the test go red, restore the fix.
   - For UI and runtime behavior, run the product and look. Mocked tests do not prove the user experience works. In microsoft/vscode, use the repository's `validate-ui-scenario` skill when it exists. For visual changes, follow [comparison-screenshot](../comparison-screenshot/SKILL.md).
   - List every claim you will make in the report and the PR. Each one needs a check behind it, plus at least one check off the happy path.
4. **Review.** Follow [preflight](../preflight/SKILL.md). Use `deep` when the user asked for it, or when the change touches security, persisted data, concurrency, or many subsystems. Continue only with `Ready for PR`.
5. **Open the PR.** Follow [cpr](../cpr/SKILL.md). Its review gate will see the fresh preflight record. Create a draft only if the user said `draft`.
6. **Babysit.** Follow [babysit](../babysit/SKILL.md) until its watcher reports ready, or only human approval remains. Prove each fix before you push it.
7. **Hand off.** Leave the PR open and unmerged.

Keep working from step 1 to step 7. While the babysit watcher runs, its exit notification will wake you. End your turn only when the work is done or you are blocked.

## Asking the user

A question in a normal message is easy to miss, because the session looks finished. Use the question tool ([asking the user](../../docs/harnesses.md#asking-the-user)), and put everything in the question: The PR link, what blocks you, and the options with your recommendation first.

Ask only when:

- you cannot prove the change,
- preflight or CI cannot reach ready honestly and you cannot fix it,
- the next step is outside the grant above,
- the goal is ambiguous in a way that changes the result, or
- another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and record each one as a `Ruling:`. If no answer comes, take the safe path: Leave the PR open and put the question at the top of your final message.

## Report

Start with one status: **Ready to merge**, **Waiting for approval**, or **Blocked**. Then give:

- the PR link and final head commit,
- a proof receipt, one row per claim: The claim, the check, the result, and its source (`ran now`, `ran earlier on an older head`, or `not run`, with the reason),
- the preflight result: Verdict, rounds, and size before and after,
- what babysitting fixed or declined,
- the `Ruling:` lines from the ledger,
- remaining risks.
