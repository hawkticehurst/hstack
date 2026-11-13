# hstack

Agent skills that make coding agents check their work, cut what isn't needed, and show the result. Works with Claude Code, Codex, VS Code, Copilot CLI, Pi, and OpenCode.

## Skills

### Build and debug

| Skill | Use it to |
|---|---|
| [`diagnose`](skills/diagnose/SKILL.md) | Find a bug's root cause: Build a repro command that fails first, then test ranked hypotheses, fix, and add a regression test. Handles flaky tests too. |
| [`blast-radius`](skills/blast-radius/SKILL.md) | Find what a change could break outside its diff, prove the one fact its safety rests on by running code, and hunt other instances of a fixed bug. |
| [`grilling`](skills/grilling/SKILL.md) | Stress-test a plan or decision one round of questions at a time. |
| [`plain`](skills/plain/SKILL.md) | Restate the last answer in plain, jargon-free words. Manual only. |

### Review

| Skill | Use it to |
|---|---|
| [`preflight`](skills/preflight/SKILL.md) | Review your own change before a PR. Parallel reviewers (trim, architecture, correctness, tests and scope, plus UI when the diff touches UI) review the whole diff; the lead validates every finding, fixes what holds up, re-reviews the fixes, and records the result. Modes: `quick`, `deep`, `cross`, `report`. |
| [`trim`](skills/trim/SKILL.md) | Cut bloat: Speculative abstractions, pass-through layers, reimplemented helpers, defensive noise, narrating comments, and test bloat. |
| [`review-pr`](skills/review-pr/SKILL.md) | Review a teammate's PR with preflight's reviewers in a temporary worktree, and draft comments for you to post. |
| [`test-audit`](skills/test-audit/SKILL.md) | Sweep a test suite for tests that prove nothing, with an evidence card per candidate. Manual only. |

### Pull requests

| Skill | Use it to |
|---|---|
| [`cpr`](skills/cpr/SKILL.md) | Create or update the PR, with comparison screenshots for visual changes. Pushes only with a fresh `ready` preflight record, unless you pass `skip-review "<reason>"`. Manual only. |
| [`comparison-screenshot`](skills/comparison-screenshot/SKILL.md) | Build the standard Before/After composite image from two authentic captures. |
| [`babysit`](skills/babysit/SKILL.md) | Drive an open PR to ready-to-merge through CI, Copilot code review and other bots, human review, and base-branch moves. Never merges. |
| [`modernize`](skills/modernize/SKILL.md) | Bring a stale PR up to date, or recommend reworking or closing it. Manual only. |
| [`ship`](skills/ship/SKILL.md) | Run the whole chain unattended: Finish, prove, preflight, cpr, babysit. Stops at ready to merge. Manual only. |

### Sessions and meta

| Skill | Use it to |
|---|---|
| [`handoff`](skills/handoff/SKILL.md) | Write a resume document so another session or harness can pick up the work. |
| [`reflect`](skills/reflect/SKILL.md) | Turn session corrections and preflight's reviewer stats into skill edits. `calibrate` replays past PRs to measure preflight against human reviewers; `audit` reviews the skills themselves. Manual only. |

### Planning and reporting

| Skill | Use it to |
|---|---|
| [`work-dispatcher`](skills/work-dispatcher/SKILL.md) | Find the issues assigned to you across your repositories, decide which you really own, and start one isolated agent session (or prepared worktree) per issue. |
| [`end-of-day`](skills/end-of-day/SKILL.md) | Report the work you completed on a day, across any repositories, and collect the screenshots embedded in those PRs. |

### Design

| Skill | Use it to |
|---|---|
| [`distill`](skills/distill/SKILL.md) | Reduce a large, growing pile of product context (docs, issues, research, chats, data, code) to evidence-backed primitives: Needs, audiences, words, objects, concepts, constraints, assumptions, principles, and open questions. Rerun it as material arrives. |
| [`shape`](skills/shape/SKILL.md) | Turn a distilled problem into three to five genuinely different design directions, help you choose, and write a prototype brief for each pick. |

The usual flow for a change: Build it (with `diagnose` for bugs), `preflight`, `cpr`, `babysit`, then a human merges. `ship` runs that chain on its own. For a design problem: `distill` (again whenever new material arrives), `shape`, prototype, then add what testing taught you back into `distill`.

## Install

| Harness | Install |
|---|---|
| Claude Code | `claude plugin marketplace add hawkticehurst/hstack`, then `claude plugin install hstack@hstack` |
| Codex | `codex plugin marketplace add hawkticehurst/hstack`, then `codex plugin add hstack@hstack` |
| VS Code | Agent customizations, Browse, Configure marketplaces, add `hawkticehurst/hstack` (setting: `chat.plugins.marketplaces`), then install `hstack` |
| Copilot CLI | `copilot plugin marketplace add hawkticehurst/hstack`, then `copilot plugin install hstack@hstack` |
| Pi | `pi install git:github.com/hawkticehurst/hstack` |
| OpenCode | Clone the repo, then add `"skills": { "paths": ["~/Code/hstack/skills"] }` to `~/.config/opencode/opencode.json`. Update with `git pull`. OpenCode asks before reading files outside the project, so allow the hstack folder when prompted. OpenCode 1.x ignores `disable-model-invocation`, so manual-only skills are visible to the model there. |

Skill names are namespaced in some harnesses: `/hstack:preflight` in Claude Code, `$preflight` in Codex, `/skill:preflight` in Pi, `@preflight` in OpenCode.

Requirements: Node.js 20 or later, `git`, and an authenticated `gh`. Pi and Claude Code install the npm dependency (`@napi-rs/canvas`, used by `comparison-screenshot`) automatically. In Copilot, Codex, and OpenCode, the compose script prints the one `npm install` command to run the first time it needs it.

After installing, remove any same-named copies from personal skill folders (`~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.pi/agent/skills`) so each skill loads once.

## How it works across harnesses

- **One manifest.** [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) is read by Copilot CLI, VS Code, Claude Code, and Codex. Pi discovers `skills/` from [`package.json`](package.json) without any manifest.
- **One skill format.** Each skill is a folder with a `SKILL.md`. Manual-only skills set `disable-model-invocation: true`, plus a three-line `agents/openai.yaml` because Codex reads only that.
- **Harness differences in one place.** Skills link to [docs/harnesses.md](docs/harnesses.md) for subagent tools, question tools, skill paths, and the headless fallback Pi uses for parallel reviewers.
- **Bundled scripts are Node.** They run anywhere these harnesses run.

## The review record

`preflight` saves a record when it finishes, in `.git/hstack/preflight.json` for each worktree, so it is never committed. The record holds a fingerprint of every changed path's mode and contents on both the base side and the working tree. Committing, or rebasing onto a base that did not touch those files, keeps it fresh. Any edit makes it stale. `cpr` runs `preflight-state check` before it pushes.

Each finding's outcome is appended to `.git/hstack/preflight-history.jsonl`. To see which reviewers earn their keep:

```sh
node skills/preflight/scripts/preflight-state.mjs stats --days 30
```

`preflight-state size` splits the diff into production code and tests and flags files that cross 1000 lines. `preflight-state gates` lists test, CI, and config hunks, and tags the ones that may weaken a gate: Skipped tests, loosened assertions, raised timeouts, suppression comments, and CI bypasses.

## The design ledger

`distill` and `shape` keep each topic in `~/.hstack/design/<topic>/` (set `HSTACK_DESIGN_HOME` to move it), outside your product repositories, because the material is often internal. Each topic is its own git repository, with one commit per run.

- `frame.md` is written with you: The decision, outcome, appetite, scope, and sources to watch.
- `ledger/` is an append-only record of sources, quotes, items, and links. The ledger script checks every quote word for word against `snapshots/`, which keeps the text of each source version, so a changed source marks the claims that quoted it as stale.
- `views/`, `README.md`, and `CHANGELOG.md` are generated, with Mermaid diagrams of audiences and needs, objects and concepts, assumptions, and directions.
- `briefs/` holds shape's prototype briefs.

```sh
node skills/distill/scripts/ledger.mjs topics
node skills/distill/scripts/ledger.mjs list --topic <topic>
```

## Develop

For live edits, add your clone as a local marketplace: `copilot plugin marketplace add ~/Code/hstack` or `claude plugin marketplace add ~/Code/hstack`, then install `hstack@hstack`. Both load local marketplaces in place.

1. Edit the skills.
2. Run `npm run check` (frontmatter, links and anchors, script syntax, manifest, and Codex policy files) and `npm test`.
3. Bump `version` in `.claude-plugin/marketplace.json`, then commit and push.

## Credits

hstack builds on ideas from [t3dotgg/tstack](https://github.com/t3dotgg/tstack), [cursor/plugins](https://github.com/cursor/plugins), [rwoll/mono-oss](https://github.com/rwoll/mono-oss), [amunger/agent-plugin](https://github.com/amunger/agent-plugin), [mattpocock/skills](https://github.com/mattpocock/skills), [obra/superpowers](https://github.com/obra/superpowers), [garrytan/gstack](https://github.com/garrytan/gstack), [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin), [badlogic/pi-mono](https://github.com/badlogic/pi-mono), and others. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
