# Harness notes

hstack's skills are written once and run in GitHub Copilot (CLI and VS Code), Claude Code, Codex, Pi, and OpenCode. Skills link here when they need a capability whose name or availability differs by harness.

## Skill directory

`<skill-dir>` in a skill means the absolute path of the directory containing that skill's `SKILL.md`.

- Copilot prints `Base directory for this skill: <path>` when it loads a skill.
- Codex and Pi list each skill's `SKILL.md` path in the system prompt.
- Claude Code prints the skill's base directory when it loads the skill.
- OpenCode's `skill` tool prints `Base directory for this skill: <path>`.

Every install method keeps the whole repository together (OpenCode reads the skills straight from your clone), so sibling links such as `../preflight/SKILL.md` and paths such as `<skill-dir>/../preflight/scripts/preflight-state.mjs` resolve. Bundled scripts need Node.js 20 or later.

## Running another hstack skill

When a skill says to follow another hstack skill, read that skill's `SKILL.md` through its relative link and follow it. Do not depend on slash-command names, because they differ by harness: `/preflight` in Copilot, `/hstack:preflight` in Claude Code, `$preflight` in Codex, `/skill:preflight` in Pi, and `/preflight` or an `@preflight` mention in OpenCode.

## Parallel subagents

Use the harness's subagent tool with a general-purpose agent, and launch independent agents in one batch so they run in parallel:

| Harness | Tool |
|---|---|
| Copilot CLI | `task` in background mode, then `read_agent` |
| VS Code | `runSubagent`, or `task` under the Copilot CLI harness |
| Claude Code | `Agent` (formerly `Task`) |
| Codex | `spawn_agent`, then `wait_agent` |
| OpenCode | `subagent` with the `general` agent (results arrive later as messages); `task` in OpenCode 1.x |

### Without a subagent tool

Pi has no built-in subagents, and a host may disable them. Run each agent as a headless one-shot of the same harness instead:

1. Write each agent's full prompt to its own file in a temporary directory outside the repository.
2. Start one background shell per agent, all at once, redirecting output to a file:

   | Harness | Command |
   |---|---|
   | Pi | `pi -p "$(cat <prompt-file>)" > <out-file>` |
   | Codex | `codex exec --sandbox read-only - < <prompt-file> > <out-file>` |
   | OpenCode | `opencode run "$(cat <prompt-file>)" > <out-file>` |
   | Claude Code | `claude -p --allowedTools "Read Grep Glob Bash(git diff:*) Bash(git status:*) Bash(git log:*) Bash(git show:*)" < <prompt-file> > <out-file>` |

3. Wait for every process, then read the output files.
4. Run `git status --short` and compare it with the status before launch. Treat any new change as that agent's failure and report it. Pi has no read-only mode, so the brief's "review only" line is the only guard there. A headless OpenCode run rejects any action that would need approval, so a reviewer that is refused `git diff` reports that instead of reviewing; treat it as incomplete.

If headless runs are impossible too, run the briefs yourself one at a time, each as a separate pass that reads only its own brief. Report that the review was not independent.

### A second model family

Some skills offer an opt-in reviewer on a different model family, for example Codex reviewing work done in Claude Code. Use the headless command of the other installed harness from the table above. Only do this when the user asked for it, because it sends the diff to that harness's provider. A missing CLI, a timeout, or unparseable output means that reviewer is incomplete, never clean.

## Asking the user

Use the harness's question tool when one exists: `ask_user` in Copilot CLI, `vscode/askQuestions` in VS Code, `AskUserQuestion` in Claude Code, `request_user_input` in Codex (available only in some modes), and `question` in OpenCode. Otherwise, ask in your reply and end your turn. Put the question first so the user does not mistake the turn for a finished task.

## Model and harness names

When a skill asks you to name the model or harness (for example in a comment attribution), use the names the harness reports. If it reports none, name the harness only. Never guess a model name.
