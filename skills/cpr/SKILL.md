---
name: cpr
description: "Use when the user invokes cpr to create or update the pull request for the current branch. Produces a concise, user-focused PR with comparison screenshots for visual changes, after a fresh preflight review."
argument-hint: Optional "draft", skip-review "<reason>", PR title, issue, or reviewer context
user-invocable: true
disable-model-invocation: true
---

# Create a Visual Pull Request

Create or update a pull request for the current branch. This skill is manual-only: Run it when the user invokes it.

Create a regular, ready-for-review pull request by default. Create a draft pull request only when the user passes `draft` or otherwise explicitly requests a draft. If a pull request already exists, preserve its current draft or ready-for-review state unless the user explicitly asks to change it.

## Configuration

Configuration uses double-brace `snake_case` placeholders. Resolve each placeholder to its configured value before invoking a command or writing the pull request body.

| Placeholder | Value |
|---|---|
| `{{github_assignee}}` | `hawkticehurst` |

## Review Gate

Push or open a pull request only for code that passed a local [preflight](../preflight/SKILL.md) review. `<skill-dir>` is the directory containing this SKILL.md.

1. Determine the base: The existing PR's base branch, or the repository default branch. Run `node <skill-dir>/../preflight/scripts/preflight-state.mjs check --base origin/<base>`.
2. Exit 0 means a fresh `ready` review covers exactly the current change. Continue.
3. Exit 1 means the review is missing, stale, or not ready. Read and follow [preflight](../preflight/SKILL.md) in its default mode with the same base, then run the check again. Continue only when it passes. If preflight ends with `Fix before PR` or `Rethink approach`, stop and report its open findings. Do not push.
4. This applies to updates of an existing PR too. Any new change needs its own fresh review.
5. Skip the gate only when the user passes `skip-review "<reason>"`, for example for a typo, docs-only, or version-bump PR. Mention the skip and the reason in your final report, not in the PR body.

Keep review results out of the PR body. Reviewers expect review to happen.

## GitHub Tooling

- Use the `gh` CLI as the default and preferred path for the entire pull request workflow: Inspect an existing PR, push the branch, create or edit the PR, set assignees, upload attachments, inspect checks, and perform final verification.
- Do not use GitHub MCP for this skill unless the user explicitly requests it. GitHub MCP authentication or permission mismatches commonly block PR creation and verification even when the authenticated `gh` CLI works.
- When invoking `gh pr create` or `gh pr edit`, use non-interactive flags such as `--repo`, `--base`, `--head`, `--title`, `--body-file`, `--assignee`, and `--attach`.
- After creation or update, verify the final PR exclusively with `gh pr view`, `gh pr checks`, and local Git commands. Confirm attachment URLs are durable `github.com/user-attachments` URLs and no local path remains in the body.

## Implementation Checklist

- Inspect the branch, working tree, staged changes, commits relative to the base branch, and any existing pull request.
- Pass the Review Gate before committing or pushing. Preflight may fix code, so commit only after it passes.
- Inspect and follow the repository pull request template exactly, preserving its comments, headings, checklist items, and ordering.
- Run the repository's focused validation for the change. For UI work, include the relevant component fixtures or equivalent visual validation.
- Commit uncommitted work using the repository's commit conventions and required trailers. Never skip hooks or signing.
- Push the branch and create a regular pull request by default, or update the existing pull request. Use draft mode only when explicitly requested.
- Set `@{{github_assignee}}` as the pull request assignee, including when updating an existing pull request. Pass `--assignee {{github_assignee}}` to `gh`.

## Visual Evidence Checklist

For any visual change, include a combined comparison image for each relevant theme or scenario:

- Before capturing new evidence, inspect the current session's artifacts, screenshot manifests, and workspace for combined comparison images already produced during issue work.
- Follow [comparison-screenshot](../comparison-screenshot/SKILL.md) to validate an existing composite or regenerate it. That skill is the single authoritative standard for authentic captures, identical crops, composition, typography, colors, geometry, preserved source images, and inspection checks.
- Reuse an existing composite when it represents the final code and passes comparison-screenshot; do not regenerate equivalent evidence unnecessarily. Regenerate it when source captures are stale, the final UI changed afterward, required themes or scenarios are missing, labels are inaccurate, or validation fails.
- Include Dark and Light themes. Include High Contrast Dark and High Contrast Light whenever borders, separators, focus indicators, colors, icons, or visibility are affected.
- Present each combined comparison image directly in the pull request description. Do not place comparison images in a Markdown table. When there are multiple themes or scenarios, give each image a short heading or caption:

  ```markdown
  ### Light 2026

  ![Light 2026 comparison](./light-2026-comparison.png)
  ```

- Upload local images with GitHub CLI's repeatable `--attach` flag so local paths in the body are rewritten to durable `github.com/user-attachments` URLs.

## Title

- Follow the repository's title conventions. Check recently merged PRs. The title usually becomes the squash commit message.
- Describe the outcome for the user, not the mechanism. Write `Keep the MCP registry policy when a refresh fails`, not `Add fallback cache to McpRegistryPolicyService`.
- Use sentence case and no trailing period, and keep it under about 72 characters.

## Pull Request Description Checklist

After the repository template content, include:

1. A **one- or two-sentence human-readable summary** explaining:
   - what users saw or could not do; and
   - how the change fixes it.
2. A short implementation bullet list when useful.
3. A **Screenshots** section that embeds the combined comparison images directly for visual changes.
4. When the change is hard to undo or reaches beyond its files, one line: `Merge danger: one-way door (<why>), blast radius <one word>`. Use preflight's reviewer callouts, such as a persisted format, storage key, setting, or public API change. Omit the line for ordinary, easily reverted changes.

Write the summary for a reviewer who has not read the code. Do not substitute a file inventory or implementation jargon for the user-visible problem and outcome.

Use sentence case in pull request prose:

- Begin every bullet point with a capitalized first word, for example `- Adds a user-scoped setting`, not `- adds a user-scoped setting`.
- Capitalize the first word after every colon, for example `High Contrast themes were not captured: The change does not affect theme colors`, not `High Contrast themes were not captured: the change does not affect theme colors`.
- Preserve normal capitalization for proper nouns, identifiers, code, commands, and URLs.

Example:

> Split-button dividers used the wrong border color at their outer edges and disappeared in High Contrast Light. The shared button now uses the correct secondary and high-contrast border colors across themes.

Turn abstract claims into concrete ones. Write "`handy commands` now finds `handy-commands`", not "Improves separator handling in search". For a new setting, command, or API, show its exact name and an example value.

Leave out:

- Validation sections that list CI-covered commands, test counts, or "lint passed". Include one sentence only when manual or environment-specific verification matters to the reviewer, or when a known gap exists.
- File-by-file or function-by-function change lists, and anything else that restates the diff.
- Process narrative such as "I first tried…" and agent or sandbox troubles.
- Hedges and disclaimers, and the same point repeated in several sections.
- Changelog-style edits such as "Update: Also handles X". When updating a PR, rewrite the body so it describes the current change, and keep every image already in the body unless you are replacing it with newer evidence of the same thing. The author may have no other copy.

Keep prose short: About 250 words for a bug fix and 350 for a feature. Images, tables, and code blocks do not count. Cut sections before you cut concrete examples.

## Final Verification

Before reporting completion:

- Run the Review Gate check again. It must still pass for the pushed change, unless the user skipped review.
- Open or fetch the final pull request and verify the title, base branch, head branch, and draft state.
- Confirm `@{{github_assignee}}` is assigned to the pull request.
- Confirm the human-readable summary is present.
- Confirm every combined comparison image renders, all Before/After labels are correct, and no local file paths or placeholders remain.
- Confirm the branch is pushed and report whether the working tree is clean.
- Return the pull request link and a concise summary of what was included.
