---
name: reflect
description: "Use when the user says 'reflect' or invokes reflect, optionally with 'calibrate' or 'audit'. Turns session corrections and preflight's reviewer history into proposed hstack skill edits; calibrate measures preflight against past human reviews; audit reviews the skills themselves."
argument-hint: "[calibrate|audit] [focus]"
user-invocable: true
disable-model-invocation: true
---

# Reflect

Make hstack better from evidence: The user's corrections, the agent's mistakes, and how preflight's reviewers actually performed.

## Configuration

| Placeholder | Value |
|---|---|
| `{{hstack_repo}}` | `~/Code/hstack` |

Edit skills only in `{{hstack_repo}}`, never in an installed plugin copy.

## 1. Gather evidence

- **This session.** Find the moments where the user corrected you ("no, do X instead"), reverted or rewrote an edit, rejected a preflight finding or fix, or repeated an instruction. Find the moments where a skill's instructions were wrong, missing, ambiguous, or ignored. Note which skill was active each time.
- **Review history.** In the current repository, run `node {{hstack_repo}}/skills/preflight/scripts/preflight-state.mjs stats --days 30`. A reviewer with a low valid rate (many `rejected`) is producing noise. A reviewer whose findings are mostly `declined` nits is aimed at the wrong things. A reviewer that never finds anything may be redundant.
- **Recent sessions.** Use the session-history tool, if one is available and the user wants a wider look. Limit it to the last 7 days and to this repository.

## 2. Classify each learning

Ask first: Could a lint rule, type, test, hook, or CI check have caught this? Look at the repository's existing `lint`, `check`, and test scripts before proposing a new one; an existing check that was not wired in or not run is itself the finding. Keep a learning only if, without a record of it, a future agent working from the current code would likely repeat the mistake.

- **One-off:** It happened once and is unlikely to recur. Drop it.
- **Encode in the product repository:** A mistake a lint rule, type, test, or CI check could make impossible. That beats prose every time. Recommend it for that repository rather than applying it from here. If the repository has its own convention for recording learnings (for example microsoft/vscode's `feedback-learning` skill), route the learning through it.
- **hstack skill edit:** Name the exact file and the smallest wording change. Prefer tightening or deleting a line over adding a paragraph. When adding a rule, include a short example of the failure it prevents.
- **New skill:** Only for a recurring workflow that no existing skill covers.

## 3. Propose, then wait

Present one table: **Learning**, **Evidence** (quote or stat), **Destination**, and **Proposed change**. Then ask the user to pick which edits to apply ([asking the user](../../docs/harnesses.md#asking-the-user)). Skill edits change every future session, so apply only what the user approves.

## 4. Apply the approved edits

1. Edit the files in `{{hstack_repo}}`.
2. Run `node {{hstack_repo}}/scripts/check.mjs`.
3. Bump the patch version of the hstack plugin in `{{hstack_repo}}/.claude-plugin/marketplace.json`.
4. Show the diff. Commit or push only when the user asks.

## Calibrate preflight (`calibrate`)

This measures preflight against real human review, a repeatable test that is better than a gut feeling.

1. Find 3 to 5 of the user's merged PRs in the repository where human reviewers asked for changes. Run `gh pr list --author @me --state merged --limit 30 --json number,title,reviews`, and pick PRs where someone other than the author requested changes or left substantive review comments. Skip bot reviews.
2. For each PR, find the last commit before the first substantive review comment, and the base as it was then: `git merge-base <that sha> <merge commit>^1`. Comparing against today's base would review an empty diff. Check the commit out in a temporary worktree (`git worktree add --detach <tmp> <sha>`).
3. Run [preflight](../preflight/SKILL.md) in `report` mode there, with `--base <the pinned base sha>`.
4. Compare preflight's findings with the human comments. Count how many human points preflight caught, how many it missed, and how many preflight findings the humans never raised (possible noise or possible wins).
5. Remove the temporary worktrees.
6. Report a per-PR table and the overall catch rate, then propose brief edits through steps 2 to 4 above. Missed classes of problems are the most valuable input.

## Audit the skills (`audit`)

Review hstack's own skills as instructions for agents, then propose edits through steps 3 and 4 above.

1. Run `node {{hstack_repo}}/scripts/check.mjs` and `npm test --prefix {{hstack_repo}}`.
2. Read every `SKILL.md` and reference file. Flag:
   - **Descriptions** that summarize the workflow instead of saying when to use the skill. Agents follow a summary instead of reading the body.
   - **No-op lines** that tell the model to do what it does by default.
   - **Negation-heavy rules** ("never", "do not") where the positive behavior could be stated instead. A prohibition puts the unwanted behavior in front of the model.
   - **Duplicated guidance** across skills that should live in one place and be linked.
   - **Sediment:** Rules added for a past incident that no longer apply, or that a script now enforces.
   - **Weight:** Skills over about 200 lines whose reference material could move into a linked file read only when needed.
3. If the session-history tool is available, list skills not used in the last 30 days as candidates to merge or remove.
