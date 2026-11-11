import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSearchQueries,
  describePullRequest,
  extractScreenshots,
  groupByRepository,
  imageSuffix,
  localDayBounds,
  screenshotFileStem,
  formatJsonOutput,
} from "../skills/end-of-day/scripts/generate-report.mjs";

test("extractScreenshots only reads the Screenshots section and dedupes URLs", () => {
  const body = [
    "## Summary",
    "![ignored](https://example.com/ignored.png)",
    "## **Screenshots**",
    "![Fallback alt](https://example.com/a.png)",
    "### Dark &amp; Light",
    '<img width="400" alt="html alt" src="https://example.com/b.png">',
    "![dup](<https://example.com/a.png> \"title\")",
    "## Testing",
    "![after](https://example.com/after.png)",
  ].join("\r\n");

  assert.deepEqual(extractScreenshots(body), [
    { label: "Fallback alt", url: "https://example.com/a.png" },
    { label: "Dark & Light", url: "https://example.com/b.png" },
  ]);
});

test("screenshotFileStem prefixes the repo, slugifies labels, and numbers repeats per PR", () => {
  const used = new Map();
  assert.equal(screenshotFileStem("microsoft/vscode", 42, "Café — Dark!", used), "microsoft-vscode-pr-42-cafe-dark");
  assert.equal(screenshotFileStem("microsoft/vscode", 42, "cafe dark", used), "microsoft-vscode-pr-42-cafe-dark-2");
  assert.equal(screenshotFileStem("a/b", 42, "日本", used), "a-b-pr-42-screenshot");
});

test("imageSuffix prefers content type, falls back to URL path, and rejects non-images", () => {
  assert.equal(imageSuffix("https://x/y", "image/jpeg; charset=binary"), ".jpg");
  assert.equal(imageSuffix("https://x/a.PNG?raw=1", null), ".png");
  assert.throws(() => imageSuffix("https://x/a.png", "text/html"), /unexpected content type text\/html/);
  assert.throws(() => imageSuffix("https://x/asset", null), /Could not determine the image format/);
});

test("search queries span the local day and cover all or selected repos", () => {
  const bounds = localDayBounds([2026, 10, 29], -300);
  assert.equal(new Date(bounds.start).toISOString(), "2026-10-29T05:00:00.000Z");
  const base = "is:pr author:me closed:2026-10-29..2026-10-30";
  assert.deepEqual(buildSearchQueries("me", [], bounds), [base]);
  assert.deepEqual(buildSearchQueries("me", ["a/b", "c/d"], bounds), [`${base} repo:a/b repo:c/d`]);
  const split = buildSearchQueries("me", ["a/b", "c/d", "e/f"], bounds, base.length + 18);
  assert.deepEqual(split, [`${base} repo:a/b repo:c/d`, `${base} repo:e/f`]);
});

test("describePullRequest reads search and pulls responses, and groupByRepository sorts repos", () => {
  const merged = describePullRequest({
    number: 1, title: "A", html_url: "https://github.com/z/web/pull/1", body: null,
    repository_url: "https://api.github.com/repos/z/web",
    closed_at: "2026-10-29T15:00:00Z", pull_request: { merged_at: "2026-10-29T15:00:00Z" },
  });
  const closed = describePullRequest({
    number: 2, title: "B", html_url: "https://github.com/a/api/pull/2",
    base: { repo: { full_name: "a/api" } }, closed_at: "2026-10-29T16:00:00Z", merged_at: null,
  });
  assert.equal(merged.repo, "z/web");
  assert.equal(merged.state, "merged");
  assert.equal(merged.body, "");
  assert.equal(closed.state, "closed");
  assert.equal(closed.merged, false);
  assert.equal(describePullRequest({ number: 3, title: "C" }), null);
  assert.deepEqual(groupByRepository([merged, closed]).map((group) => [group.repo, group.pullRequests.length]), [
    ["a/api", 1],
    ["z/web", 1],
  ]);
});

test("formatJsonOutput escapes non-ASCII characters", () => {
  assert.equal(formatJsonOutput({ t: "é😀" }), '{\n  "t": "\\u00e9\\ud83d\\ude00"\n}');
});
