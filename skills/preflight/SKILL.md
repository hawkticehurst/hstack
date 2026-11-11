---
name: preflight
description: "Use before opening or updating a pull request, or when the user says 'preflight', 'preflight quick', 'preflight deep', or asks for a local review of their change. Reviews the whole branch diff with parallel reviewers, fixes what holds up, and records the fresh review that the cpr skill requires."
argument-hint: "[quick|deep] [report] [cross] [issue URL or number] [--base <ref>]"
user-invocable: true
---

# preflight

Review the current change locally, fix what holds up, and loop until it is ready for a PR. The [cpr](../cpr/SKILL.md) skill pushes only when a fresh `ready` record from this skill covers the exact change.

## Arguments

- No mode: The standard reviewers.
- `quick`: One reviewer covers the standard briefs. Use it for small diffs and for fixes made while babysitting a PR.
- `deep`: Adds a skeptic and a second correctness reviewer, and a fresh agent double-checks every `blocker` before you act on it. Use it for risky, cross-cutting, or contested changes.
- `report`: Review and report only. Every step stays read-only, including a broken build, which you report instead of fixing.
- `cross`: Implies `deep`, and runs `correctness-2` on a different model family through another installed harness. See [a second model family](../../docs/harnesses.md#a-second-model-family). Use it only when the user asks.
- An issue URL or number: The spec to check against.
- `--base <ref>`: The base to compare against. Default: The PR's base branch if a PR exists, otherwise `origin/HEAD`.

`<skill-dir>` is the directory containing this SKILL.md. `<preflight-state>` means `node <skill-dir>/scripts/preflight-state.mjs`. Pass the same `--base` to every `<preflight-state>` call.

## 1. Frame the change

1. Run `git status --short`. If the working tree mixes this change with unrelated work, ask the user to move that work out (for example into another worktree) before you continue. The record covers every changed file, so a review of only some paths can never be saved as `ready`. Leave the user's work in place: Never stash, discard, or reset it.
2. If the branch has a PR (`gh pr view --json number,url,baseRefName,body`), use `origin/<baseRefName>` as the base and read the PR body.
3. Run `<preflight-state> base`. If the base does not resolve or the diff is empty, stop and say so.
4. State the goal in one or two sentences from the session, the issue, and the PR. Find the spec: The issue argument, a `Fixes` or `Closes` link in the PR or commits, or the user's requirements from this session. Read issues with `gh issue view <n> --comments`. If you cannot tell what the change is for, ask before you review ([asking the user](../../docs/harnesses.md#asking-the-user)).
5. Collect the applicable repository instructions: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` whose `applyTo` matches changed files, and `CONTRIBUTING.md`. List the repository's own skills (`.github/skills`, `.agents/skills`, `.claude/skills`) by name and description. Reviewers read the ones that match the change.
6. Run the repository's focused build, type check, and tests for the touched area. Reviewers need code that builds. If the change breaks the build, fix that first. Read each test run's summary line: A run that selected zero tests is a failure, not a pass.
7. Run `<preflight-state> size` and `<preflight-state> gates`, and keep both outputs.

## 2. Review in parallel

Choose the reviewers, then announce the choice in one line each, including why any conditional reviewer runs or does not.

| Reviewer | Brief | Ids | Runs |
|---|---|---|---|
| trim | [../trim/reviewer.md](../trim/reviewer.md) | `trim-N` | always |
| architecture | [reviewers/architecture.md](reviewers/architecture.md) | `arch-N` | always |
| correctness | [reviewers/correctness.md](reviewers/correctness.md) | `bug-N` | always |
| tests-and-scope | [reviewers/tests-and-scope.md](reviewers/tests-and-scope.md) | `test-N` | always |
| ui | [reviewers/ui.md](reviewers/ui.md) | `ui-N` | when the diff changes rendered UI: CSS, markup, components, menus, keybindings, hovers, theme colors, focus, or in microsoft/vscode a `browser/` or `electron-browser/` file that touches the DOM or UI services |
| skeptic | [reviewers/skeptic.md](reviewers/skeptic.md) | `skeptic-N` | `deep` |
| correctness-2 | [reviewers/correctness.md](reviewers/correctness.md) | `bug2-N` | `deep` |

Launch them as separate general-purpose agents, all at once ([parallel subagents](../../docs/harnesses.md#parallel-subagents)). Each one reviews the **whole** change, never a slice of files. Leave the files untouched while reviewers run.

- `quick`: One agent receives every brief that would run and keeps each brief's id prefix.
- `deep`: Keep the two correctness reviewers blind to each other. Without `cross`, choose a different model family for `correctness-2` if the harness lets you pick models. Otherwise say in the report that model diversity was not achieved.

Give every reviewer the full text of its brief, followed by this shared context:

```
Review only. Do not edit, stage, commit, push, or post anything, and do not launch subagents.
Repository: <absolute path>    Base: <ref> @ <merge-base sha>
Goal: <one or two sentences>
Spec: <issue link and the requirements, or "none">
Out of scope: <anything the user explicitly excluded>
Diff: run `git diff <merge-base sha>`, then `git status --short` and read untracked files.
Size: <preflight-state size output>
Gates: <preflight-state gates output>
Checks already run: <commands and results, with test counts>
Repository instructions: <paths>
Repository skills: <name: description, one per line, or "none">

Severity:
- blocker: the intended case is wrong, or the change crashes, loses data, opens a security hole, breaks the build or tests, or weakens a test or check to make it pass.
- should: a real bug that callers will hit within the goal; or a simplification that removes meaningful code or a whole concept without changing behavior; or a missing test that would let a realistic regression through.
- nit: everything else, including rare paths, small performance costs, naming, style, and speculative risks.

Finding format, best first:
<id> [blocker|should|nit] path:line - the problem in one sentence
  Trigger: when it happens
  Evidence: what you read or ran that proves it, with path:line
  Fix: the smallest root-cause fix (and net lines, if it removes code)

Flag only problems the change introduces or makes worse, with impact you can show. Skip anything a linter or type checker already enforces, and anything the code explicitly and deliberately suppresses with a stated reason. Return no findings rather than weak ones.
```

Right after the reviewers finish and before you edit anything, run `<preflight-state> snapshot` and keep the tree id for the re-review delta.

## 3. Validate every finding

Reviewers return candidates, not facts. Check each one against the current code yourself.

- **Reject** a finding that the code already prevents, that relies on a misreading, that is speculation, or that a linter already enforces. Record the evidence.
- **Re-rank** by the severity rules, whatever label the reviewer gave. A rare path or a small cost is a nit. A stated rationale, in a comment, the PR, or the session, never lowers a severity. Only evidence that the problem cannot happen does.
- **Merge** duplicates and keep every contributing id, for example `trim-1+arch-2`.
- **Resolve** conflicting advice between reviewers by choosing one and saying why.
- **Hold scope.** Prefer the fix that deletes or narrows code over one that adds a lock, cache, helper, or option. Decline a fix that grows the change more than the problem warrants. Problems that predate the change are follow-ups unless the change makes them worse.
- **Double-check blockers in `deep`.** Before acting on a `blocker` you accept, or rejecting one, give a fresh agent the finding, the shared context, and your reasoning, and ask it to confirm or refute with evidence. You wrote or adopted this code, so you are not a neutral judge.

## 4. Fix (skip in `report` mode)

If a validated finding carries `Approach: rethink`, stop before fixing anything. Ask the user, presenting the alternative, its tradeoffs, and three options: Rework the approach, keep the approach and fix the other findings, or stop. Recommend one.

Otherwise apply every validated `blocker` and `should` fix without asking. Use the smallest root-cause change. Decline nits, except trim nits that only delete code.

Ask the user first only when a fix would:

- need a product or UX decision,
- add or change a public API, setting, or user-visible behavior beyond the goal,
- remove a test, check, or code that looks intentional, including any trim cut marked `significant`, or
- substantially edit files outside the change.

After the fixes, rerun the focused build, type check, and tests, then rerun `<preflight-state> size` and `<preflight-state> gates`. If the fixes grew the change, cut first.

## 5. Re-review the fixes

Run another round only if a `blocker` or `should` was fixed in behavior code. Comment, doc, or formatting-only fixes do not need one.

Launch one general-purpose agent with [reviewers/verifier.md](reviewers/verifier.md), the shared context, the ledger (every finding with its outcome and your evidence), and the output of `<preflight-state> delta <snapshot tree>`. Take a new snapshot, then validate and fix its findings exactly as in steps 3 and 4.

- **Budget:** Three rounds in total. Extend to five only when a security, data-loss, or concurrency `blocker` stays open with evidence, or when the user asks.
- **Stop early** when a round returns only nits or `APPROVE`.
- **Disputes:** If you and a reviewer still disagree after two exchanges, stop. Report both positions in two or three lines each and let the user decide. Agreement is earned by evidence, not by the loop ending. The end of the budget is not approval.

## 6. Record the result

After the last edit, write the ledger as a JSON array to a temporary file outside the repository. Each entry has `id`, `reviewer` (comma-separated reviewer names for merged findings), `severity`, `outcome` (`fixed`, `open`, `declined`, or `rejected`), `title`, and `reason`. Then run:

```
<preflight-state> save --verdict <ready|fix|rethink> --mode <quick|standard|deep> --rounds <n> --findings <ledger path>
```

The verdict is `ready` only when no `blocker` or `should` remains open. In `report` mode, still save the record, so a clean `ready` result counts for the cpr skill. The record goes stale as soon as the change is edited, so save it last.

## 7. Report

Write the report in plain language, following [plain](../plain/SKILL.md): Short sentences, everyday words, and each technical term explained the first time it appears. Keep file paths and line numbers, because the user needs them to act. Open with a few sentences on what the review means for the user: Is the change ready, what changed, and what they need to decide. The details follow.

```
preflight: Ready for PR | Fix before PR | Rethink approach

<Two or three plain sentences: the verdict and why, what preflight fixed, and what still needs the user.>

What I fixed
1. path:line. <what was wrong, in plain words> Now: <what changed>. (blocker, bug-1)
2. path:line. <...> (-70 lines) (should, trim-1+arch-2)

Needs your decision
1. path:line. <the problem in plain words, why it matters, and my recommendation> (should, test-1)

Things a human reviewer should know: <for example, adds the `chat.foo` setting> or none
Left alone: arch-3 (a naming preference), test-2 (outside this change; worth a follow-up)
Not real problems: bug-3 (already handled at path:line)
Follow-ups: <optional larger improvements, if any>

Details: <goal>; reviewers <list, and why ui ran or not>; size +412 -38 -> +231 -30 (prod +290 -> +141); <n> rounds (<mode>); checks <commands, results, and test counts>; reviewers that failed or returned nothing: <none, or which and why>
```

In `report` mode, nothing is fixed yet, so call the first list **What I would fix** and number every finding you validated. End by telling the user how to continue, for example: "Reply `apply` to fix all of them, `apply 1, 3` for some, or tell me what to change."

**Things a human reviewer should know** are reviewer callouts: Changes worth weighing even when nothing is wrong, such as a new or changed setting, command, keybinding, or public or extension API; a storage key, persisted format, or migration; telemetry or policy; a new dependency or lockfile change; anything hard to undo. They do not change the verdict.

A reviewer that failed or returned nothing did not approve the change. Say which ones.

The fixes stay in the working tree. Committing, pushing, and opening the PR belong to the user or the cpr skill.

## Applying a report

When the user approves fixes after a `report` run ("apply", "yes, make these changes", "fix 1 and 3"), continue this same run rather than starting over or switching skills:

1. Confirm the working tree still matches the snapshot from step 2 (`<preflight-state> delta <snapshot tree>` is empty). If the user edited files since then, review again from step 1, because the findings may be stale.
2. Apply the approved findings as in step 4, and mark the rest `declined` with the user's reason.
3. Re-review the fixes as in step 5, record the result as in step 6, and report as in step 7.

The new record replaces the report-mode one, so cpr sees the fixed change.
