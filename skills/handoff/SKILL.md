---
name: handoff
description: "Write a compact handoff document so another session, or another harness such as Copilot, Claude Code, Codex, or Pi, can resume the current work without this conversation. Use when the user says 'handoff', 'write a handoff', 'hand this off', or 'I'm switching agents', or is about to end, fork, or move a session mid-task. Produces a markdown file saved outside the repository and prints its path with a one-line resume prompt."
argument-hint: "[what the next session should focus on]"
user-invocable: true
---

# Handoff

Write the state of the work to a file a fresh agent can read cold. A handoff is for work that has to travel: To another harness, another worktree, a teammate, or a side task forked off this one.

If the user gave an argument, it is what the next session is for. Keep what bears on it and drop the rest.

Link to what is already written down (issues, PRs, commits, specs, plans) by URL or path. Do not copy it.

`<skill-dir>` means the absolute path of the directory containing this SKILL.md. See [harness notes](../../docs/harnesses.md#skill-directory).

## 1. Gather the facts

Run commands rather than recalling:

- Repository and location: `git remote get-url origin`, `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse --short HEAD`.
- Working tree: `git status --short` and `git diff --stat HEAD`. Summarize; do not paste diffs. Unpushed commits: `git log --oneline @{upstream}..` (or against the base if there is no upstream).
- PR: `gh pr view --json number,url,state,isDraft,baseRefName` and a one-line summary of `gh pr checks`, if a PR exists.
- Preflight record: `node <skill-dir>/../preflight/scripts/preflight-state.mjs check`, with the same `--base` the session used. Record the output: Fresh and ready, stale, not ready, or no record.
- Anything the session left running, such as a babysit watcher or a dev server, and how to check on it or restart it.

## 2. Write it

Keep it to about one screen. Use this shape and drop empty sections:

```markdown
# Handoff: <short title>

<date and time>, from <harness and model, per the harness notes>

## Goal
<the user's words, quoted where you can>. Done when: <condition>.

## State
- Repo: <owner/name>. Worktree: <absolute path>. Branch: <branch> @ <short sha>
- Uncommitted: <summary, or clean>. Unpushed commits: <count, or none>
- PR: <url, draft or open, checks summary>, or none
- Preflight: <check output>
- Running: <process and how to reattach or restart>, or none

## Decisions
- <decision>, because <why>. Settled unless new evidence says otherwise.

## Verified
- `<exact command>`: <result>

## Assumed, not verified
- <belief the session did not check>

## Open questions
- <question>, for <the user | the next agent>

## Next steps
1. <first concrete action>

## Skills to use next
- <hstack skill name>: <when, for example preflight before the PR, then cpr>

## Authority
<what the user allowed, such as pushing this branch, and what they did not>

## Resume
Read this file. Re-check the live state (status, branch, PR, checks), because it may have moved. Do not redo verified work or reopen settled decisions without new evidence. Start at Next steps 1.
```

Keep verified facts and assumptions apart. A belief written as a fact becomes the next agent's false premise.

Replace every secret (tokens, keys, passwords, cookies, auth headers, connection strings) with `<REDACTED>`, and leave out private details the next agent does not need.

## 3. Save it

Save to `~/.local/state/hstack/handoffs/<repo>-<branch>-<YYYYMMDD-HHMM>.md`, outside the repository, unless the user names another place. Create the directory if needed. Some harnesses and reboots clear temporary directories, so do not use one.

Write the file with your file-writing tool, not through shell interpolation, which mangles backticks and `$`.

Reply with the absolute path and a prompt the user can paste into the next session:

```
Read <absolute path> and resume the work it describes.
```

Do not commit, push, or post anything.
