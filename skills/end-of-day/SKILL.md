---
name: end-of-day
description: "Use when the user wants an end-of-day (EOD) report, daily work summary, standup notes, or a Slack update of the pull requests they merged or closed on a given day, or wants to gather the screenshots embedded in those pull requests. Works across all of the user's GitHub repositories or a chosen set."
argument-hint: "[YYYY-MM-DD, defaults to today] [owner/repo ...]"
user-invocable: true
disable-model-invocation: false
---

# End of Day

Report the pull requests the user merged or closed on one local calendar day,
across any repositories, and download the screenshots already embedded in those
pull request descriptions.

## Configuration

Edit these defaults to change what a plain run reports. Arguments in the user's
request override them for that run.

| Setting | Default | Flag |
| --- | --- | --- |
| Author | The authenticated GitHub user | `--author LOGIN` |
| Repositories | All repositories | `--repo OWNER/NAME` (repeat for several) |
| Output root | `~/Desktop/screenshots` | `--output-root PATH` |

Screenshots go to `<output root>/YYYY-MM-DD-end-of-day`. Pass
`--no-screenshots` when the user only wants the report.

## Screenshot Contract

Never create, pair, label, crop, resize, recompress, or otherwise compose
screenshots in this skill, and never run the
[comparison screenshot skill](../comparison-screenshot/SKILL.md) just to produce
this report. The image embedded in the pull request description is the source of
truth: The [comparison screenshot skill](../comparison-screenshot/SKILL.md)
makes it, the [cpr skill](../cpr/SKILL.md) embeds it under **Screenshots**, and
this skill downloads it unchanged.

## Procedure

1. Resolve the report date from the user's request; use today's local date when
   none is given. Resolve repositories and author from the request, falling back
   to [Configuration](#configuration).
2. Run the bundled generator. `<skill-dir>` is the absolute path of the folder
   containing this SKILL.md:

   ```bash
   node <skill-dir>/scripts/generate-report.mjs --date YYYY-MM-DD \
     [--repo OWNER/NAME ...] [--author LOGIN] [--output-root PATH] [--no-screenshots]
   ```

3. Read the JSON printed to stdout:

   - `repositories`: `[{ repo, pullRequests }]`, sorted by repository name.
   - `pullRequests`: The same entries as a flat list ordered by close time. Each
     has `repo`, `number`, `title`, `url`, `state` (`merged`, `closed`, or
     `open`), `merged`, `closedAt`, and `screenshotCount`.
   - `screenshots`: `{ repo, pullRequest, label, sourceUrl, path }` for each
     downloaded image.
   - `outputFolder`: Absolute screenshot folder, or `null` with
     `--no-screenshots`.
   - `author`, `repositoryFilter` (`"all"` or a list), `date`, `timezone`,
     `warnings`, and `errors`.

   A non-empty `errors` array or a nonzero exit status means the run is
   incomplete; report each error. Report `warnings` too, but a run with only
   warnings did not fail.
4. Confirm every path in `screenshots` exists.
5. Reply with a copy-pasteable Markdown block. Mark pull requests whose `state`
   is `closed` with `(closed without merging)`. With one repository, list the
   entries directly:

   ```md
   End of day report:

   - {PR title} {PR URL}
   - {PR title} {PR URL} (closed without merging)
   ```

   When more than one repository appears, group by repository in the order of
   `repositories`:

   ```md
   End of day report:

   **owner/repo-a**
   - {PR title} {PR URL}

   **owner/repo-b**
   - {PR title} {PR URL}
   ```

   When no pull requests match, say so instead of producing an empty list.
6. If any screenshots were downloaded, add a folder link after the block, using
   the exact absolute `outputFolder` path as the link target so it opens in the
   file app:

   ```md
   PR screenshots: [Open folder](/absolute/path/from/outputFolder)
   ```

## Screenshot Collection

The generator reads Markdown and HTML images only inside each pull request
description's **Screenshots** section, downloads each unique image once, and
keeps the server-provided format. Files are named
`<owner>-<repo>-pr-<number>-<label>.<ext>`, using subheadings or alt text as the
label. Pull requests without screenshots are normal and appear with
`screenshotCount: 0`; do not reconstruct missing evidence.

## Targeting Specific Pull Requests

For a one-off download or validation, pass pull request numbers with exactly one
repository. `--date` then only names the output folder:

```bash
node <skill-dir>/scripts/generate-report.mjs --repo OWNER/NAME --pr 1234 [--pr 5678]
```

## Requirements and Failures

- Requires Node.js 20 or newer. No npm dependencies, FFmpeg, or image tools.
- Authenticates with `GITHUB_TOKEN` or `GH_TOKEN`, falling back to
  `gh auth token`. The default author comes from that identity; if none is
  available, the run fails with an error asking for `--author` or a sign-in.
  Private repositories only appear when the token can see them.
- Search, rate-limit, and HTTP failures appear in `errors`. Never silently omit a
  failed download; report its `errors` entry and pull request.
