---
name: review-pr
description: "Review a teammate's pull request locally with preflight's reviewers, without editing its code or posting anything, and draft a review the user can post. Use when the user says 'review this PR', 'review #123', 'look at this PR', or gives a PR URL to review someone else's work. For the user's own branch, use preflight instead. Produces a summary, severity-ordered concerns with file:line, notes on tests, open questions, and drafted inline comments."
argument-hint: "<PR number or URL> [quick|deep]"
user-invocable: true
---

# Review PR

Review someone else's PR the way [preflight](../preflight/SKILL.md) reviews your own change, then hand the user a review they can post.

This skill is read-only. Do not edit the PR's code, and do not post comments, approve, or request changes unless the user explicitly asks.

`<skill-dir>` means the absolute path of the directory containing this SKILL.md. `<preflight-state>` means `node <skill-dir>/../preflight/scripts/preflight-state.mjs`.

## 1. Read the PR

1. `gh pr view <pr> --json number,url,title,author,body,baseRefName,headRefOid,files,commits` and `gh pr view <pr> --comments`.
2. Read the existing inline threads (`gh api repos/<owner>/<repo>/pulls/<n>/comments`) so you do not repeat what others already raised.
3. Read linked issues (`Fixes #n`, `Closes #n`) with `gh issue view <n> --comments`.
4. State the goal in one or two sentences. If you cannot tell what the PR is for, put that under Open questions instead of guessing.

## 2. Check out the head in a temporary worktree

Never switch the user's own checkout. Use the remote that points at the PR's base repository, usually `origin`:

```
git fetch origin <baseRefName> pull/<n>/head
git worktree add --detach <temp dir outside the repo> <headRefOid>
```

Confirm `git -C <worktree> rev-parse HEAD` equals `headRefOid`. The base for everything below is `origin/<baseRefName>`.

Run the PR's focused build and tests when a finding depends on behavior. A new worktree may lack dependencies. If so, report the checks as not run rather than starting a long install, unless the user asked for it.

## 3. Run the reviewers

Use preflight's reviewers in `report` mode, as described in [preflight step 2](../preflight/SKILL.md#2-review-in-parallel). Launch them as [parallel subagents](../../docs/harnesses.md#parallel-subagents), all at once:

| Reviewer | Brief | Modes |
|---|---|---|
| trim | [../trim/reviewer.md](../trim/reviewer.md) | standard, deep |
| architecture | [../preflight/reviewers/architecture.md](../preflight/reviewers/architecture.md) | standard, deep |
| correctness | [../preflight/reviewers/correctness.md](../preflight/reviewers/correctness.md) | standard, deep |
| tests-and-scope | [../preflight/reviewers/tests-and-scope.md](../preflight/reviewers/tests-and-scope.md) | standard, deep |
| ui | [../preflight/reviewers/ui.md](../preflight/reviewers/ui.md) | when the PR changes rendered UI, as preflight defines it |
| skeptic | [../preflight/reviewers/skeptic.md](../preflight/reviewers/skeptic.md) | deep |

`quick` gives one reviewer every brief that would run. Give each reviewer its full brief and preflight's shared context, with these values:

- Repository: The worktree path. Base: `origin/<baseRefName>` @ `git -C <worktree> merge-base HEAD origin/<baseRefName>`.
- Goal and spec: From the PR body and linked issues.
- Size and gates: `<preflight-state> size --base origin/<baseRefName>` and `<preflight-state> gates --base origin/<baseRefName>`, run from the worktree.
- One extra line: "This is a teammate's PR. Review only; the author will make the fixes."

## 4. Validate

Check every finding against the code yourself, exactly as in [preflight step 3](../preflight/SKILL.md#3-validate-every-finding). Also:

- Drop or credit findings that an existing thread already raised.
- Problems that predate the PR are not its concerns unless the PR makes them worse.
- Do not run `<preflight-state> save`. Preflight records belong to the user's own changes.

## 5. Write the review

```
PR: <url>, <title> by @<author>
Suggested verdict: Approve | Comment | Request changes

What it does
<one short paragraph: the change and its intent>

Good
- <solid choices worth keeping>

Concerns
1. [blocker] path:line. <problem>. Trigger: <when>. Fix: <smallest fix>
2. [should] ...
3. [nit] ...
(or "None found.")

Tests
- <what is covered, what is missing, whether a realistic break would be caught>
- <commands run and results, or "not run: <why>">

Open questions
- <only what blocks a merge decision; omit the section if none>

Draft inline comments
- path:line
  <comment text, ready to paste>
```

Write each inline comment for the author: Lead with the problem and the concrete fix, one concern per comment, short and kind. Phrase it as a question when you are not sure. Add a `suggestion` block when the fix is a small replacement.

## 6. Clean up

Run `git worktree remove <worktree>`. If it refuses because files changed, report which ones (a reviewer broke the read-only rule), then remove it with `--force`. Confirm the user's own `git status --short` is unchanged.

## Posting, only when asked

If the user asks you to post, post only the comments they approved, as one review, with the event they chose (`COMMENT` unless they said approve or request changes). Begin the review body with the attribution note from [babysit](../babysit/SKILL.md#comments-posted-for-the-user), and check the text for secrets and private details first.

Write the payload to a JSON file with `commit_id` set to `headRefOid`, `event`, `body`, and `comments`. Each comment has `path`, `line`, `side`, and `body`. Use `side: "RIGHT"` with the new file's line number for added or unchanged lines, and `side: "LEFT"` with the old file's line number for removed lines and deleted files. Every line must appear in the PR's diff, or GitHub rejects the whole review. Then run:

```
gh api repos/<owner>/<repo>/pulls/<n>/reviews --input <payload file>
```
