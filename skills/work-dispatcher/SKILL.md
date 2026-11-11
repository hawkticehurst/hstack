---
name: work-dispatcher
description: "Use when the user invokes work-dispatcher, asks to triage or dispatch their assigned issues, or from a scheduled dispatch automation. Discovers the open issues assigned to the user across one or more configured repositories, decides which ones the user actually owns, and starts one isolated agent session per issue to work on it."
argument-hint: "[owner/repo ...] [prepare] [max <n>]"
user-invocable: true
---

# Work dispatcher

Find the issues assigned to the user, decide which ones are really theirs to implement, and start one isolated agent session per issue. Run the complete workflow on every invocation, manual or scheduled.

The dispatcher itself only discovers, classifies, and dispatches. It leaves code, commits, pushes, pull requests, and every piece of GitHub state (comments, labels, assignees, open or closed) untouched.

## Configuration

Placeholders use double braces. Resolve every placeholder, including nested ones, before calling a tool, creating a session, or sending a child prompt.

| Placeholder | Value |
|---|---|
| `{{assignee}}` | The authenticated GitHub user (`gh api user --jq .login`) |
| `{{max_new_sessions}}` | `20` |
| `{{ignored_labels}}` | `modernization`, `triage-needed`, `~info-needed`, `info-needed`, `agent-skip` |
| `{{handled_elsewhere_labels}}` | `testplan-item` (a separate automation handles these) |
| `{{explicit_skips}}` | `microsoft/vscode#325240`, `microsoft/vscode#330693` |
| `{{session_marker}}` | `[work:{{repo}}#{{issue_number}}]` |
| `{{assignee_role}}` | `UX Engineer` |
| `{{assignee_likely_domains}}` | `UI, UX, interaction design, visual behavior, accessibility, and related product experience work` |
| `{{assignee_focus}}` | `VS Code customizations: agents, skills, instructions, hooks, prompts, MCP servers, plugins, customization discovery and enablement, and management UI` |

Repositories to dispatch from. Each needs a local checkout to create worktrees in.

| Repository | Workspace | Legacy marker |
|---|---|---|
| `microsoft/vscode` | `Q:\Code\vscode` | `[vscode-issue:#{{issue_number}}]` |

- An argument naming repositories limits this run to those rows.
- When a workspace path does not exist on this machine, look for a checkout of that repository under the usual code folders (for example `~/Code` or `Q:\Code`), confirm `git remote get-url origin` matches, and use it. If none exists, report the repository as having no workspace and dispatch nothing from it.
- The legacy marker column keeps sessions from an earlier version of this skill from being dispatched twice.

Runtime fields are `{{repo}}` (`owner/name`), `{{issue_number}}`, `{{issue_title}}`, `{{issue_url}}`, and `{{workspace}}`.

## 1. Discover

1. Search every open issue assigned to `{{assignee}}`, across all repositories: `gh search issues --assignee {{assignee}} --state open --limit 500 --json repository,number,title,url,labels,updatedAt`. Pull requests are not issues; drop them.
2. Split the results into configured repositories and **not configured** ones. Report the not-configured ones with counts and titles, so the user sees their whole catalog, but do not dispatch them.
3. For each configured issue, read the body, labels, all assignees, author, relevant comments, linked issues and PRs, and the update time (`gh issue view <n> -R {{repo}} --comments --json ...`).
4. Exclude issues in `{{explicit_skips}}`, issues with a label in `{{handled_elsewhere_labels}}`, and issues with a label that case-insensitively and exactly matches one in `{{ignored_labels}}`.
5. Find previous attempts. With session tools (below), list every session, archived ones included, and skip an issue whose `{{session_marker}}` or legacy marker appears in any session title. In `prepare` mode, skip an issue whose dispatch branch or prompt file already exists.

## 2. Classify

### Containers

Never dispatch a container, epic, umbrella, workstream, milestone, burndown, or coordination issue as an implementation task. Decide from the issue's structure, not its repository or title. Strong signals, several of which usually appear together:

- a broad Goal, Done when, or Completion rules section,
- many independently completable tracked items, or a long checklist split among people or subsystems,
- a Related issues or References inventory,
- several assignees representing a workstream,
- progress or burndown language,
- no single reproducible defect or bounded unit of work,
- completion that depends mainly on linked issues.

A checklist alone is not enough when it is the test or acceptance plan for one bounded change. Report a container with its tracker evidence and any child issues that look relevant to `{{assignee}}`. A child must appear in discovery on its own and pass every gate to be dispatched.

### Ownership

Assignment is necessary but not sufficient: Automation assigns triage, and multi-assignee issues often include `{{assignee}}` only for awareness.

- `{{assignee}}` is a `{{assignee_role}}`; `{{assignee_likely_domains}}` are their usual domain, and they currently focus on `{{assignee_focus}}`.
- Strong evidence of real ownership: A direct teammate request, an explicit ownership statement, a task or checklist item naming `{{assignee}}`, or a clear history of `{{assignee}}` implementing in that area.
- With several assignees, presume coordination or awareness until evidence names who implements. Relevance to the role alone does not choose `{{assignee}}` over another assignee. Positive evidence: The body or a comment assigns the concrete work to `{{assignee}}`, `{{assignee}}` owns the unresolved deliverable, another assignee asks for their implementation, or history shows them actively implementing. Evidence of FYI: Another assignee is named as owner, `{{assignee}}` is included for review, design input, or awareness, or the work sits in another assignee's subsystem.
- Also treat bot or random assignment, triage or routing wording, requests to find an owner, and clear ownership by another team as signs of FYI.
- Assignee order and author are not ownership evidence, and neither is job title alone.

Give every eligible issue one class:

- `APPROPRIATE`: Strong evidence `{{assignee}}` personally owns a concrete implementation. Dispatch it.
- `FYI/HANDOFF`: Strong evidence of awareness, triage, or someone else's implementation.
- `UNCERTAIN`: Insufficient or conflicting evidence.
- `CONTAINER`: A tracker rather than a bounded issue.

Only `APPROPRIATE` issues are dispatched. Record no marker for the others, so they are reconsidered when their metadata changes.

## 3. Dispatch

Sort `APPROPRIATE` issues by most recently updated, and dispatch at most `{{max_new_sessions}}` (or the `max` argument). Immediately before each dispatch, re-check previous attempts and re-verify that the issue is open, still assigned to `{{assignee}}`, and not excluded.

**With session tools.** When the host can create agent sessions (for example the VS Code Agents window's session tools), create one independent session per issue:

- workspace `{{workspace}}`, with worktree isolation enabled,
- exact title `{{issue_title}} {{session_marker}}`,
- the child prompt below.

Then rename the created session to that exact title, because automatic title generation can drop the marker.

**Without session tools, or with `prepare`.** Prepare each issue for the user to start in any harness:

1. Create a worktree: `git -C {{workspace}} fetch origin`, then `git -C {{workspace}} worktree add -b {{assignee}}/issue-{{issue_number}} <worktrees folder>/<repo name>-{{issue_number}} origin/<default branch>`. Use the repository's existing worktrees folder if it has one, otherwise a sibling folder of `{{workspace}}`.
2. Write the child prompt to `~/.local/state/hstack/dispatch/<owner>-<name>-{{issue_number}}.md`.
3. Report the worktree path and a start command per installed harness, for example `cd <worktree> && claude "$(cat <prompt file>)"`, `codex "$(cat <prompt file>)"`, or `copilot -i "$(cat <prompt file>)"`.

Start agents yourself in this mode only when the user asks.

### Child prompt

```text
Keep this session's title exactly: {{issue_title}} {{session_marker}}
If automatic title generation changes it, rename it back.

Work on {{repo}} issue #{{issue_number}}: {{issue_title}}
Issue URL: {{issue_url}}
Work only on this issue in this isolated worktree. Do not commit, push, open a pull request, or change GitHub issue state.

Re-verify that the issue is open, assigned to {{assignee}}, not a container, and that {{assignee}} personally owns the concrete work, especially with several assignees. Otherwise report NO_ACTION.

Read the issue's full context, then inspect the code, tests, history, and established patterns. Check whether it is already fixed, duplicated, obsolete, unreproducible, or being implemented elsewhere. Do not trust a root-cause analysis written in the issue; trace the code path yourself. Decide whether the expected behavior, the current failure, the root cause, a scoped implementation, and a validation plan are all clear.

If they are clear, implement a precise, complete fix that follows the repository's instructions. For a bug, follow hstack's diagnose skill. Add or update focused tests and related docs, and run the smallest relevant validation. Then run hstack's preflight skill on the change and resolve what it finds. Leave everything uncommitted.

If behavior, design intent, reproduction, acceptance criteria, implementation choices, or ownership remain unclear, change nothing. Report NEEDS_INPUT with what you found, the exact ambiguity, its impact, options, and a recommendation, and ask the single most useful question with the harness's question tool.

For any visible UI, interaction, layout, theme, or accessibility change, screenshots are required: the original problem when reproducible, the happy path, and the important edge, error, empty, loading, disabled, overflow, and interaction states, in the relevant themes and constrained layouts, with deterministic non-sensitive data. When before and after states both exist, follow hstack's comparison-screenshot skill and show the combined image first. If the change is not visual, say why screenshots do not apply. If required evidence cannot be captured, do not claim completion.

Final report: begin with IMPLEMENTED, NEEDS_INPUT, NO_ACTION, or BLOCKED. Include the outcome, the clarity and ownership assessment, findings, changes, exact validation and results, the preflight verdict, the screenshot manifest or why there is none, risks or questions, and what the reviewer should do next.
```

## 4. Report

Return a table per group:

1. **Dispatched:** Repository, issue, title, session or worktree, result.
2. **Ignored by label or skip list:** Repository, issue, title, reason.
3. **Containers:** Issue, title, tracker evidence, potentially relevant children.
4. **FYI/Handoff:** Issue, title, ownership evidence, likely owner or area.
5. **Uncertain:** Issue, title, the uncertainty, one routing question.
6. **Not configured:** Repository, open assigned issue count, titles.

Then counts: Assigned open issues, excluded by label or skip list, previous attempts, containers, FYI or handoff, uncertain, dispatched, and deferred by the limit. Report every classification even when nothing was dispatched.
