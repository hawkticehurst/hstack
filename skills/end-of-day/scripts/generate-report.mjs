#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const MARKDOWN_IMAGE_PATTERN =
  /!\[(?<alt>[^\]]*)\]\(\s*(?:<(?<angle>https?:\/\/[^>]+)>|(?<url>https?:\/\/[^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gi;
const HTML_IMAGE_PATTERN = /<img\b[^>]*\bsrc=["'](?<url>https?:\/\/[^"']+)["'][^>]*>/gi;
const HEADING_PATTERN = /^(?<marks>#{1,6})\s+(?<title>.+?)\s*$/;
const LINE_BREAK_PATTERN = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const USER_AGENT = "hstack-end-of-day";
const URL_IMAGE_SUFFIXES = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const IMAGE_EXTENSIONS = {
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jp2": ".jp2",
  "image/jpeg": ".jpg",
  "image/jxl": ".jxl",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/vnd.microsoft.icon": ".ico",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
};
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
  middot: "\u00b7", bull: "\u2022", times: "\u00d7", rarr: "\u2192",
  larr: "\u2190", uarr: "\u2191", darr: "\u2193", harr: "\u2194",
};
const LEGACY_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg", "laquo", "raquo", "middot", "times"]);

export class ReportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportError";
  }
}

export class UsageError extends Error {}

export function htmlUnescape(value) {
  if (!value.includes("&")) {
    return value;
  }
  return value.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)/g, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1).replace(";", ""), hex ? 16 : 10);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return "\ufffd";
      }
      return String.fromCodePoint(codePoint);
    }
    const name = entity.endsWith(";") ? entity.slice(0, -1) : entity;
    if (Object.hasOwn(NAMED_ENTITIES, name) && (entity.endsWith(";") || LEGACY_ENTITIES.has(name))) {
      return NAMED_ENTITIES[name];
    }
    return match;
  });
}

function splitLinesLikeOriginal(value) {
  const lines = value.split(LINE_BREAK_PATTERN);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function stripChars(value, chars) {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function normalizeHeading(value) {
  let result = value.replace(/\s+#+\s*$/, "");
  result = result.replace(/<[^>]+>/g, "");
  result = result.replace(/[*_`]/g, "");
  return htmlUnescape(result).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function cleanLabel(value, fallback) {
  let result = value.replace(/<[^>]+>/g, "");
  result = result.replace(/[*_`~]/g, "");
  result = stripChars(htmlUnescape(result), " \t:-#");
  return result || fallback;
}

export function extractImageReferences(value) {
  const references = [];
  for (const match of value.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const url = match.groups.angle || match.groups.url;
    references.push({ alt: htmlUnescape(match.groups.alt).trim(), url: htmlUnescape(url) });
  }
  for (const match of value.matchAll(HTML_IMAGE_PATTERN)) {
    const altMatch = /\balt=["']([^"']*)["']/i.exec(match[0]);
    references.push({
      alt: altMatch ? htmlUnescape(altMatch[1]).trim() : "",
      url: htmlUnescape(match.groups.url),
    });
  }
  return references;
}

export function extractScreenshots(body) {
  let sectionLevel = null;
  let subsectionLabel = "";
  const screenshots = [];
  const seenUrls = new Set();

  for (const line of splitLinesLikeOriginal(body)) {
    const headingMatch = HEADING_PATTERN.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch.groups.marks.length;
      const heading = cleanLabel(headingMatch.groups.title, "");
      const normalized = normalizeHeading(headingMatch.groups.title);
      if (sectionLevel === null) {
        if (normalized === "screenshot" || normalized === "screenshots") {
          sectionLevel = level;
        }
        continue;
      }
      if (level <= sectionLevel) {
        break;
      }
      subsectionLabel = heading;
      continue;
    }

    if (sectionLevel === null) {
      continue;
    }

    for (const reference of extractImageReferences(line)) {
      if (seenUrls.has(reference.url)) {
        continue;
      }
      seenUrls.add(reference.url);
      screenshots.push({ label: subsectionLabel || reference.alt || "screenshot", url: reference.url });
    }
  }

  return screenshots;
}

export function slugify(value) {
  const asciiValue = value.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase();
  const slug = stripChars(asciiValue.replace(/[^a-z0-9]+/g, "-"), "-");
  return slug.slice(0, 80) || "screenshot";
}

// Mirrors urllib.parse.urlparse: Scheme, then the path without netloc, query, fragment, or ;params.
export function parseUrlParts(url) {
  let rest = url;
  let scheme = "";
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    rest = end === -1 ? "" : rest.slice(2 + end);
  }
  let urlPath = rest.split("#", 1)[0].split("?", 1)[0];
  const paramsIndex = urlPath.indexOf(";", Math.max(urlPath.lastIndexOf("/"), 0));
  if (paramsIndex !== -1) {
    urlPath = urlPath.slice(0, paramsIndex);
  }
  return { scheme, path: urlPath };
}

function pathSuffix(urlPath) {
  const name = urlPath.replace(/\/+$/, "").split("/").pop() ?? "";
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index) : "";
}

export function imageSuffix(url, contentType) {
  if (contentType) {
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (!mediaType.startsWith("image/")) {
      throw new ReportError(`Image URL returned unexpected content type ${mediaType}.`);
    }
    if (Object.hasOwn(IMAGE_EXTENSIONS, mediaType)) {
      return IMAGE_EXTENSIONS[mediaType];
    }
  }
  const suffix = pathSuffix(parseUrlParts(url).path).toLowerCase();
  if (URL_IMAGE_SUFFIXES.has(suffix)) {
    return suffix;
  }
  throw new ReportError(`Could not determine the image format for ${url}.`);
}

// The repository prefix keeps same-numbered PRs from different repositories apart.
export function screenshotFileStem(repo, number, label, usedNames) {
  const baseSlug = slugify(label);
  const occurrence = (usedNames.get(baseSlug) ?? 0) + 1;
  usedNames.set(baseSlug, occurrence);
  const nameSuffix = occurrence > 1 ? `-${occurrence}` : "";
  return `${slugify(repo)}-pr-${number}-${baseSlug}${nameSuffix}`;
}

export function parseGithubDatetime(value) {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export function formatDate(date) {
  const [year, month, day] = date;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function utcDateParts(time) {
  const date = new Date(time);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

// Local day bounds use the fixed UTC offset in effect when the script runs.
export function localDayBounds(reportDate, offsetMinutes) {
  const [year, month, day] = reportDate;
  const start = Date.UTC(year, month - 1, day) - offsetMinutes * 60_000;
  return { start, end: start + 86_400_000 };
}

export const MAX_SEARCH_QUERY_LENGTH = 256;

// GitHub ORs repeated `repo:` qualifiers but caps query length, so long repo lists are split into several queries.
export function buildSearchQueries(author, repos, bounds, maxLength = MAX_SEARCH_QUERY_LENGTH) {
  const base =
    `is:pr author:${author} ` +
    `closed:${formatDate(utcDateParts(bounds.start))}..${formatDate(utcDateParts(bounds.end))}`;
  if (repos.length === 0) {
    return [base];
  }
  const queries = [];
  let current = base;
  let count = 0;
  for (const repo of repos) {
    const qualifier = ` repo:${repo}`;
    if (count > 0 && current.length + qualifier.length > maxLength) {
      queries.push(current);
      current = base;
      count = 0;
    }
    current += qualifier;
    count += 1;
  }
  queries.push(current);
  return queries;
}

function quotePathSegment(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, "/");
}

function byClosedAt(left, right) {
  const a = left.closedAt || "";
  const b = right.closedAt || "";
  return a < b ? -1 : a > b ? 1 : 0;
}

export function repositoryFromApiItem(item) {
  if (typeof item.base?.repo?.full_name === "string") {
    return item.base.repo.full_name;
  }
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url ?? "");
  if (match) {
    return match[1];
  }
  const htmlMatch = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(item.html_url ?? "");
  return htmlMatch ? htmlMatch[1] : null;
}

// Normalizes a search item or a pulls API response into one report entry.
export function describePullRequest(item) {
  const { number, title, html_url: url } = item;
  const repo = repositoryFromApiItem(item);
  if (!Number.isInteger(number) || typeof title !== "string" || typeof url !== "string" || repo === null) {
    return null;
  }
  const mergedAt = item.merged_at ?? item.pull_request?.merged_at ?? null;
  const closedAt = item.closed_at ?? null;
  const state = mergedAt ? "merged" : closedAt ? "closed" : "open";
  return { repo, number, title, url, state, merged: Boolean(mergedAt), closedAt, body: item.body || "" };
}

export function groupByRepository(pullRequests) {
  const groups = new Map();
  for (const pullRequest of pullRequests) {
    if (!groups.has(pullRequest.repo)) {
      groups.set(pullRequest.repo, []);
    }
    groups.get(pullRequest.repo).push(pullRequest);
  }
  return [...groups.keys()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((repo) => ({ repo, pullRequests: groups.get(repo) }));
}

function describeFetchError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "timed out";
  }
  return error?.cause?.message || error?.message || String(error);
}

async function fetchWithIdleTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), timeoutMs);
  };
  touch();
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    touch();
    return { response, touch, done: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function runGh(args) {
  try {
    const output = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
    return output.trim() || null;
  } catch {
    return null;
  }
}

export function resolveToken(env = process.env, gh = runGh) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || gh(["auth", "token"]) || null;
}

export class GitHubClient {
  constructor(token) {
    this.token = token;
    this.headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      this.headers.Authorization = `Bearer ${token}`;
    }
  }

  async getAuthenticatedLogin(gh = runGh) {
    if (this.token) {
      const user = await this.getJson("/user");
      if (typeof user?.login === "string" && user.login) {
        return user.login;
      }
    }
    const login = gh(["api", "user", "--jq", ".login"]);
    if (login) {
      return login;
    }
    throw new ReportError(
      "Could not determine the authenticated GitHub user. Pass --author, set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.",
    );
  }

  async getPullRequest(repo, number) {
    const [owner, name] = repo.split("/");
    const result = await this.getJson(`/repos/${quotePathSegment(owner)}/${quotePathSegment(name)}/pulls/${number}`);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new ReportError("GitHub returned an invalid pull request response.");
    }
    return result;
  }

  async searchClosedPullRequests(query, warnings) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({ q: query, per_page: "100", page: String(page), sort: "updated" });
      const result = await this.getJson(`/search/issues?${params}`);
      const pageItems = result !== null && typeof result === "object" && !Array.isArray(result) ? result.items : undefined;
      if (!Array.isArray(pageItems)) {
        throw new ReportError("GitHub returned an invalid search response.");
      }
      if (result.incomplete_results === true) {
        warnings.push(`GitHub reported incomplete search results for: ${query}`);
      }
      items.push(...pageItems.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item)));
      const total = Number.isInteger(result.total_count) ? result.total_count : 0;
      if (pageItems.length < 100 || items.length >= total) {
        break;
      }
      // The search API serves at most 1,000 results per query.
      if (items.length >= 1000) {
        warnings.push(`GitHub search returned ${total} results; only the first 1000 are included for: ${query}`);
        break;
      }
    }
    return items;
  }

  async getJson(apiPath) {
    let fetched;
    let text;
    try {
      fetched = await fetchWithIdleTimeout(`https://api.github.com${apiPath}`, this.headers, 30_000);
      text = await fetched.response.text();
    } catch (error) {
      throw new ReportError(`GitHub API request failed: ${describeFetchError(error)}`);
    } finally {
      fetched?.done();
    }
    const { response } = fetched;
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new ReportError(
          `GitHub API rate limit or access error (${response.status}). Set GITHUB_TOKEN ` +
            `or GH_TOKEN (or run \`gh auth login\`) and retry. Response: ${text}`,
        );
      }
      throw new ReportError(`GitHub API request failed (${response.status}): ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ReportError(`GitHub API returned invalid JSON for ${apiPath}.`);
    }
  }
}

export async function downloadImage(url, destinationStem) {
  if (!["http", "https"].includes(parseUrlParts(url).scheme)) {
    throw new ReportError(`Unsupported image URL: ${url}`);
  }
  let fetched;
  try {
    fetched = await fetchWithIdleTimeout(url, { "User-Agent": USER_AGENT }, 60_000);
    const { response, touch } = fetched;
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReportError(`Could not download image ${url}: HTTP ${response.status}`);
    }
    let suffix;
    try {
      suffix = imageSuffix(url, response.headers.get("Content-Type"));
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const destination = `${destinationStem}${suffix}`;
    const keepAlive = new Transform({
      transform(chunk, _encoding, callback) {
        touch();
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body ?? new ReadableStream()), keepAlive, createWriteStream(destination));
    return destination;
  } catch (error) {
    if (error instanceof ReportError) {
      throw error;
    }
    throw new ReportError(`Could not download image ${url}: ${describeFetchError(error)}`);
  } finally {
    fetched?.done();
  }
}

// Returns raw API items; search results are filtered to the exact local day.
export async function loadPullRequests(client, { author, repos, numbers, bounds, warnings }) {
  if (numbers.length > 0) {
    const items = [];
    for (const number of numbers) {
      items.push(await client.getPullRequest(repos[0], number));
    }
    return items;
  }
  const seen = new Set();
  const items = [];
  for (const query of buildSearchQueries(author, repos, bounds)) {
    for (const item of await client.searchClosedPullRequests(query, warnings)) {
      const closedAt = parseGithubDatetime(item.closed_at);
      const key = item.html_url ?? item.url;
      if (closedAt === null || seen.has(key)) {
        continue;
      }
      if (bounds.start <= closedAt.getTime() && closedAt.getTime() < bounds.end) {
        seen.add(key);
        items.push(item);
      }
    }
  }
  return items;
}

export function parseRepository(value) {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UsageError("Repository must use the owner/name format.");
  }
  return `${parts[0]}/${parts[1]}`;
}

export function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(2000, month - 1, day));
    date.setUTCFullYear(year);
    if (year >= 1 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return [year, month, day];
    }
  }
  throw new UsageError("Date must use the YYYY-MM-DD format.");
}

function parseInteger(value) {
  if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(value)) {
    throw new UsageError(`invalid int value: '${value}'`);
  }
  return Number.parseInt(value.replace(/_/g, ""), 10);
}

export function expandUser(value) {
  if (value === "~" || value.startsWith("~/")) {
    return path.join(process.env.HOME || homedir(), value.slice(1));
  }
  return value;
}

const USAGE =
  "usage: generate-report.mjs [-h] [--date DATE] [--author LOGIN] [--repo OWNER/NAME ...]\n" +
  "                          [--output-root OUTPUT_ROOT] [--no-screenshots] [--pr NUMBER ...]";
const HELP = `${USAGE}

Report pull requests you closed or merged on a local day and collect the screenshots embedded in them.

options:
  -h, --help            show this help message and exit
  --date DATE           Local report date in YYYY-MM-DD format (default: today).
  --author LOGIN        PR author (default: the authenticated GitHub user).
  --repo OWNER/NAME     Limit to this repository; repeat for several (default: all repositories).
  --output-root OUTPUT_ROOT
                        Parent folder for YYYY-MM-DD-end-of-day (default: ~/Desktop/screenshots).
  --no-screenshots      Skip downloading screenshots and creating the output folder.
  --pr NUMBER           Report a specific pull request instead of searching; repeatable; needs exactly one --repo.
`;

const OPTIONS = {
  "--date": { dest: "date", parse: parseDate },
  "--repo": { dest: "repos", parse: parseRepository, append: true },
  "--author": { dest: "author", parse: (value) => value.replace(/^@/, "") },
  "--output-root": { dest: "outputRoot", parse: (value) => value },
  "--no-screenshots": { dest: "screenshots", flag: false },
  "--pr": { dest: "pullRequests", parse: parseInteger, append: true },
};

export function parseArgs(argv) {
  const args = {
    date: null,
    repos: [],
    author: null,
    outputRoot: "~/Desktop/screenshots",
    screenshots: true,
    pullRequests: [],
    help: false,
  };
  const unrecognized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      args.help = true;
      return args;
    }
    if (!token.startsWith("--") || token === "--") {
      unrecognized.push(token);
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const candidates = Object.keys(OPTIONS).filter((name) => name === flag || name.startsWith(flag));
    const name = candidates.includes(flag) ? flag : candidates.length === 1 ? candidates[0] : null;
    if (candidates.length > 1 && name === null) {
      throw new UsageError(`ambiguous option: ${flag} could match ${candidates.join(", ")}`);
    }
    if (name === null) {
      unrecognized.push(token);
      continue;
    }
    const option = OPTIONS[name];
    if ("flag" in option) {
      if (equalsIndex !== -1) {
        throw new UsageError(`argument ${name}: ignored explicit argument '${token.slice(equalsIndex + 1)}'`);
      }
      args[option.dest] = option.flag;
      continue;
    }
    let value;
    if (equalsIndex !== -1) {
      value = token.slice(equalsIndex + 1);
    } else if (index + 1 < argv.length && !/^-[^\d]/.test(argv[index + 1])) {
      index += 1;
      value = argv[index];
    } else {
      throw new UsageError(`argument ${name}: expected one argument`);
    }
    let parsed;
    try {
      parsed = option.parse(value);
    } catch (error) {
      throw new UsageError(`argument ${name}: ${error.message}`);
    }
    if (option.append) {
      if (!args[option.dest].includes(parsed)) {
        args[option.dest].push(parsed);
      }
    } else {
      args[option.dest] = parsed;
    }
  }
  if (unrecognized.length > 0) {
    throw new UsageError(`unrecognized arguments: ${unrecognized.join(" ")}`);
  }
  if (args.pullRequests.length > 0 && args.repos.length !== 1) {
    throw new UsageError("argument --pr: requires exactly one --repo OWNER/NAME");
  }
  return args;
}

// Pretty-printed JSON with non-ASCII characters escaped so the output is safe in any terminal encoding.
export function formatJsonOutput(value) {
  return JSON.stringify(value, null, 2).replace(
    /[^\x20-\x7e\n]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function timezoneLabel(now) {
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(now)
    .find((entry) => entry.type === "timeZoneName");
  return part?.value || "UTC";
}

function localDateParts(now) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()];
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${USAGE}\ngenerate-report.mjs: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const reportDate = args.date ?? localDateParts(now);
  const bounds = localDayBounds(reportDate, offsetMinutes);
  let outputFolder = null;
  if (args.screenshots) {
    const folderName = `${formatDate(reportDate)}-end-of-day`;
    const outputRoot = path.resolve(expandUser(args.outputRoot));
    mkdirSync(path.join(outputRoot, folderName), { recursive: true });
    outputFolder = path.join(realpathSync(outputRoot), folderName);
  }

  const result = {
    date: formatDate(reportDate),
    timezone: timezoneLabel(now),
    author: args.author,
    repositoryFilter: args.repos.length > 0 ? args.repos : "all",
    outputFolder,
    repositories: [],
    pullRequests: [],
    screenshots: [],
    warnings: [],
    errors: [],
  };
  const finish = () => {
    result.repositories = groupByRepository(result.pullRequests);
    process.stdout.write(`${formatJsonOutput(result)}\n`);
    return result.errors.length > 0 ? 1 : 0;
  };

  const client = new GitHubClient(resolveToken());
  let items;
  try {
    if (args.pullRequests.length === 0 && result.author === null) {
      result.author = await client.getAuthenticatedLogin();
    }
    items = await loadPullRequests(client, {
      author: result.author,
      repos: args.repos,
      numbers: args.pullRequests,
      bounds,
      warnings: result.warnings,
    });
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    result.errors.push(error.message);
    finish();
    return 1;
  }

  const pullRequests = [];
  for (const item of items) {
    const pullRequest = describePullRequest(item);
    if (pullRequest === null) {
      result.errors.push("GitHub returned incomplete metadata for a pull request.");
    } else {
      pullRequests.push(pullRequest);
    }
  }
  pullRequests.sort(byClosedAt);

  for (const { body, ...pullRequest } of pullRequests) {
    const entry = { ...pullRequest, screenshotCount: 0 };
    result.pullRequests.push(entry);
    if (outputFolder === null) {
      continue;
    }

    const usedNames = new Map();
    for (const screenshot of extractScreenshots(body)) {
      const stem = screenshotFileStem(entry.repo, entry.number, screenshot.label, usedNames);
      let outputPath;
      try {
        outputPath = await downloadImage(screenshot.url, path.join(outputFolder, stem));
      } catch (error) {
        if (!(error instanceof ReportError)) throw error;
        result.errors.push(`${entry.repo}#${entry.number} image '${screenshot.label}': ${error.message}`);
        continue;
      }

      entry.screenshotCount += 1;
      result.screenshots.push({
        repo: entry.repo,
        pullRequest: entry.number,
        label: screenshot.label,
        sourceUrl: screenshot.url,
        path: outputPath,
      });
    }
  }

  return finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
