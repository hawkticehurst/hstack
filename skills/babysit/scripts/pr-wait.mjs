#!/usr/bin/env node
// pr-wait: Watch one GitHub pull request and print one line per real event.
//
// Adapted from t3dotgg/tstack's skills/babysit-pr/scripts/pr-wait (MIT, see
// THIRD_PARTY_NOTICES.md). hstack changes: Waits for Copilot code review, adds
// --review-bots, blocks `ready` on requested changes, and is ported from Python
// to a dependency-free Node module (Node >= 20) that shells out to `gh`.
//
//   node pr-wait.mjs <pr> [--repo owner/name] [--until green|ready|any-change]
//                    [--interval 20] [--review-bots auto|none|login,login]
//
// <pr> is a PR number or PR URL. Without --repo, the repo comes from the URL or
// from the current checkout. Stdout carries only events, one line each, so a
// monitor wakes the agent once per real event. Progress and errors that do not
// end the run go to stderr.
//
// --until
//   green       required checks passed on the current head (every CI check when
//               the base branch requires none; a head with no CI at all counts
//               once no checks appear for a few polls)
//   ready       green, every expected review bot reviewed the current head, no
//               review thread is unresolved, no reviewer still requests changes,
//               and the branch is not BEHIND (default)
//   any-change  stop after the first poll that prints an event
//
// Exit codes
//   0  the --until condition is met, or the PR merged
//   1  something needs action: New review feedback arrived (even while CI runs),
//      a required check or an expected review bot's check failed, the branch
//      conflicts with its base, the PR closed, `ready` is blocked by unresolved
//      threads, requested changes, or a BEHIND branch, or GitHub stayed unreachable
//   2  bad arguments, unknown PR, or another pr-wait already watches this PR
//
// Events
//   - a required check failed (name and link)
//   - all checks finished on the head (one summary line)
//   - a new comment, review, thread, or thread reply from someone other than the
//     PR author or the gh user
//   - a review bot (Greptile, Macroscope, Copilot code review, CodeRabbit)
//     finished on the head, or a Greptile or Macroscope summary changed after that
//   - the base branch moved and the new commits touch files in this PR
//   - merge state became BEHIND or DIRTY
//   - the PR merged or closed
//
// --review-bots
//   auto        (default) wait for a known review bot only once it shows up on
//               the PR: As a check, a summary, a review, or a requested reviewer
//   none        never wait for review bots
//   a,b         wait for these bots (substrings of their login or check name)
//
// Copilot code review only re-reviews when requested, so it counts as done once it
// reviewed the head or is no longer a requested reviewer.
//
// CodeRabbit is advisory: Pr-wait reports it but never waits for it. Comment
// edits are never events, and top-level comments from CI and deploy bots
// (github-actions, Vercel) are skipped, because checks already carry that news.
//
// State lives in ~/.local/state/hstack/pr-wait/. A lock file makes a second
// watcher for the same PR exit at once. A state file lets a restarted watcher
// report what arrived while no watcher ran. The first run for a PR records what
// already exists and reports only what comes after.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_GATING_BOTS = Object.freeze(['greptile', 'macroscope', 'copilot-pull-request-reviewer']);
// Bots that review only when requested. They are done once no longer requested.
export const REQUEST_DRIVEN_BOTS = Object.freeze(['copilot-pull-request-reviewer']);
export const ADVISORY_BOTS = Object.freeze(['coderabbit']);
// CI and deploy bots report through checks. Their PR comments are status reports.
export const STATUS_BOTS = Object.freeze(['github-actions', 'vercel', 'netlify', 'railway', 'cloudflare']);
export const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'hstack', 'pr-wait');
// A state file older than this describes an old session. Start a fresh baseline
// instead of replaying hours of comments as new events.
export const STALE_STATE_MS = 6 * 3600 * 1000;
export const MAX_FAILED_POLLS = 10;
// Polls in a row with no CI checks on a head before treating it as having no CI.
export const NO_CI_POLLS = 3;
export const TRANSIENT = new RegExp(
  'HTTP (5\\d\\d|429)|rate limit|timed? ?out|connection (reset|refused)|EOF|' +
    'temporar|could not resolve host|TLS handshake|Something went wrong',
  'i',
);
const FAILED = ['fail', 'cancel'];
// gh pr checks buckets, worst first. Duplicate names (push and pull_request runs
// of one job) collapse to the worst bucket.
const RANK = { fail: 4, cancel: 3, pending: 2, pass: 1, skipping: 0 };

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url state headRefOid baseRefName mergeStateStatus
      author { login }
      baseRef { target { oid } }
      reviewRequests(first: 50) {
        nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
      }
      comments(last: 100) { nodes { id url body author { login __typename } } }
      reviews(last: 100) {
        nodes { id url state body commit { oid } author { login __typename } }
      }
      reviewThreads(last: 100) {
        nodes {
          isResolved path line
          comments(first: 100) { nodes { id url body author { login __typename } } }
        }
      }
    }
  }
}
`;

export class GhError extends Error {
  constructor(message, transient) {
    super(message);
    this.name = 'GhError';
    this.transient = transient;
  }
}

// A fatal error before watching starts. Printed to stdout so a monitor shows the agent why it stopped.
export class Fatal extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'Fatal';
    this.code = code;
  }
}

// Thrown by Watcher.poll when the run should end with this exit code.
export class Finish {
  constructor(code) {
    this.code = code;
  }
}

function log(message) {
  process.stderr.write(`pr-wait: ${message}\n`);
}

// --- Review bot policy ---------------------------------------------------------

/**
 * Which bots pr-wait waits for. `gating` changes with --review-bots, never what
 * counts as a bot. `explicit` (an explicit list) waits for each listed bot even
 * before it shows up.
 */
export function makePolicy(reviewBots = 'auto') {
  if (reviewBots === 'none') return { gating: [], explicit: false };
  if (reviewBots === 'auto') return { gating: [...DEFAULT_GATING_BOTS], explicit: false };
  const gating = [...new Set(reviewBots.split(',').filter((b) => b.trim()).map(canonicalBot))];
  return { gating, explicit: true };
}

/** Every review bot pr-wait recognizes, whether or not it waits for it. */
export function knownBots(policy) {
  const builtIn = [...DEFAULT_GATING_BOTS, ...ADVISORY_BOTS];
  return [...builtIn, ...policy.gating.filter((b) => !builtIn.includes(b))];
}

/** Map a --review-bots selector such as `copilot` to the bot it names. */
export function canonicalBot(selector) {
  const s = selector.trim().toLowerCase();
  return [...DEFAULT_GATING_BOTS, ...ADVISORY_BOTS].find((bot) => bot.includes(s)) ?? s;
}

/** Which review bot a login or check name belongs to, if any. */
export function botName(text, policy) {
  const lowered = (text || '').toLowerCase();
  return knownBots(policy).find((bot) => lowered.includes(bot)) ?? null;
}

// --- Text helpers ----------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', bull: '\u2022', times: '\u00d7', larr: '\u2190',
  rarr: '\u2192', uarr: '\u2191', darr: '\u2193', check: '\u2713', cross: '\u2717', laquo: '\u00ab',
  raquo: '\u00bb', deg: '\u00b0', plusmn: '\u00b1', ge: '\u2265', le: '\u2264', ne: '\u2260',
};

// Named entities HTML also accepts without the trailing semicolon.
const LEGACY_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg', 'deg', 'plusmn', 'times', 'laquo', 'raquo', 'middot']);

function fromCodePoint(n) {
  if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(n);
}

/** HTML entity decoding: numeric references and the common named entities. */
export function unescapeHtml(text) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, ref) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      return fromCodePoint(parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    if (!match.endsWith(';') && !LEGACY_ENTITIES.has(ref)) return match;
    return Object.hasOwn(ENTITIES, ref) ? ENTITIES[ref] : match;
  });
}

export function who(node) {
  const author = node.author || {};
  return [author.login || 'ghost', author.__typename === 'Bot'];
}

export function plain(body) {
  const text = (body || '').replace(/<!--[\s\S]*?-->/g, ' ');
  return unescapeHtml(text.replace(/<[^>]+>/g, ' '));
}

export function snippet(body, limit = 100) {
  const text = plain(body).replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit - 3).join('') + '...';
}

/** The verdict line of a bot summary (Macroscope, Greptile), if it has one. */
export function verdict(body) {
  for (const line of plain(body).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
    if (/verdict|confidence score/i.test(line)) return snippet(line.replaceAll('*', ''), 80);
  }
  return '';
}

export function digest(body) {
  const text = plain(body).replace(/\s+/g, ' ');
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Collapse `gh pr checks` rows by name, keeping the worst bucket. Insertion order is preserved. */
export function collapseChecks(rows) {
  const checks = new Map();
  for (const row of rows) {
    const current = checks.get(row.name);
    if (current === undefined || (RANK[row.bucket] ?? 2) > (RANK[current.bucket] ?? 2)) checks.set(row.name, row);
  }
  return checks;
}

// --- gh ----------------------------------------------------------------------------

function runGh(args) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ status: 127, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code, signal) => {
      const status = code ?? -(os.constants.signals[signal] ?? 1);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Run gh. Retries transient failures (HTTP 5xx or 429, network) with backoff. */
export async function gh(args, { allow = [0], run = runGh, sleep = delay } = {}) {
  let wait = 2;
  for (let attempt = 0; ; attempt++) {
    const proc = await run(args);
    const transient = proc.status !== 0 && TRANSIENT.test(proc.stderr);
    if (!transient && allow.includes(proc.status)) return proc;
    const lines = proc.stderr.trim().split(/\r?\n/);
    const message = lines.at(-1) || `gh exited ${proc.status}`;
    if (!transient || attempt === 4) throw new GhError(message, transient);
    log(`gh ${args.slice(0, 2).join(' ')}: ${message}; retry in ${wait}s`);
    await sleep(wait * 1000);
    wait *= 2;
  }
}

async function ghLines(args) {
  return (await gh(args)).stdout.split(/\r?\n/).filter(Boolean);
}

/** The GitHub reads a Watcher needs. Tests replace this with fakes. */
export function githubClient(repo, pr) {
  const [owner, name] = repo.split('/');
  return {
    async fetchPr() {
      const proc = await gh([
        'api', 'graphql', '-f', `query=${QUERY}`,
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`,
      ]);
      const data = JSON.parse(proc.stdout).data;
      const node = data.repository.pullRequest;
      node.viewer = data.viewer.login;
      return node;
    },

    // gh pr checks exits 8 while checks are pending and 1 when one failed.
    // Those are states, not errors: Read the JSON and ignore the exit code.
    async checkRows() {
      const proc = await gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,bucket,link,description'], {
        allow: [0, 1, 8],
      });
      if (!proc.stdout.trim()) {
        if (proc.stderr.includes('no checks reported')) return [];
        throw new GhError(proc.stderr.trim() || `gh pr checks exited ${proc.status}`, false);
      }
      return JSON.parse(proc.stdout);
    },

    // Required check names for the base branch, from rulesets and classic branch
    // protection. Knowing them up front means a required check that has not
    // started yet counts as pending, instead of green by omission.
    async requiredChecks(base) {
      const sources = [
        [
          `repos/${repo}/rules/branches/${base}`,
          '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
        ],
        [`repos/${repo}/branches/${base}/protection/required_status_checks`, '.contexts[]?, .checks[]?.context'],
      ];
      const names = new Set();
      for (const [apiPath, jq] of sources) {
        try {
          for (const line of await ghLines(['api', apiPath, '--jq', jq])) names.add(line);
        } catch (error) {
          if (!(error instanceof GhError)) throw error;
          // 404 means no protection, which is normal.
          if (!error.message.includes('HTTP 404')) log(`could not read required checks from ${apiPath}: ${error.message}`);
        }
      }
      return names;
    },

    async prFiles() {
      return ghLines(['pr', 'diff', String(pr), '-R', repo, '--name-only']);
    },

    async compareFiles(oldOid, newOid) {
      return ghLines(['api', `repos/${repo}/compare/${oldOid}...${newOid}`, '--jq', '.files[].filename']);
    },

    async behindBy(baseOid, head) {
      return (await gh(['api', `repos/${repo}/compare/${baseOid}...${head}`, '--jq', '.behind_by'])).stdout.trim();
    },
  };
}

// --- Target and lock ---------------------------------------------------------------

export async function parseTarget(raw, repo, { github = gh } = {}) {
  if (raw == null || !raw.trim()) {
    throw new Fatal('missing PR number. Did a variable expand to nothing? Usage: pr-wait <pr> [--repo owner/name]');
  }
  const url = raw.trim().match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/);
  const number = raw.trim().match(/^#?(\d+)$/);
  let pr;
  if (url) {
    repo = repo || url[1];
    pr = Number(url[2]);
  } else if (number) {
    pr = Number(number[1]);
  } else {
    throw new Fatal(`'${raw}' is not a PR number or PR URL`);
  }
  if (pr <= 0) throw new Fatal(`'${raw}' is not a valid PR number`);
  if (!repo) {
    try {
      repo = (await github(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).stdout.trim();
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      throw new Fatal(`no --repo given and the current directory has no GitHub repo (${error.message})`);
    }
  }
  if (!/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u.test(repo)) throw new Fatal(`'${repo}' is not owner/name`);
  try {
    await github(['pr', 'view', String(pr), '-R', repo, '--json', 'number']);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    // A transient failure is retried by the poll loop.
    if (!error.transient) throw new Fatal(`cannot read ${repo}#${pr}: ${error.message}`);
  }
  return [repo, pr];
}

function stateBase(stateDir, repo, pr) {
  return path.join(stateDir, `${repo.replaceAll('/', '__')}__${pr}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Hold a per-PR lock file containing our pid. A lock whose pid is dead is taken
 * over. Returns a release function that removes the file if we still own it.
 */
export function acquireLock(repo, pr, { stateDir = STATE_DIR } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = `${stateBase(stateDir, repo, pr)}.lock`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let text = '';
      let age = Infinity;
      try {
        text = fs.readFileSync(lockPath, 'utf8').trim();
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      const pid = /^\d+$/.test(text) ? Number(text) : null;
      // An empty, fresh lock file belongs to a watcher that is still writing its pid.
      if ((pid !== null && pidAlive(pid)) || (pid === null && age < 2000)) {
        const shown = pid ?? 'unknown';
        throw new Fatal(
          `pid ${shown} already watches ${repo}#${pr}, so this watcher exits to avoid ` +
            `duplicate events. If no events reach you from it, run \`kill ${shown}\` and start again.`,
        );
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
      continue;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try {
        if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    };
  }
  throw new Fatal(`could not take the lock for ${repo}#${pr}`);
}

// --- Watcher -------------------------------------------------------------------------

export class Watcher {
  /**
   * @param {object} options
   * @param {string} options.repo owner/name
   * @param {number} options.pr
   * @param {'green'|'ready'|'any-change'} [options.until]
   * @param {number} [options.interval] seconds between polls
   * @param {{gating: string[], explicit: boolean}} [options.policy] from makePolicy()
   * @param {string} [options.stateDir]
   * @param {object} [options.github] GitHub reads, see githubClient()
   * @param {(line: string) => void} [options.out] stdout writer for event lines
   * @param {(line: string) => void} [options.log] stderr progress writer
   * @param {(ms: number) => Promise<void>} [options.sleep]
   */
  constructor({
    repo, pr, until = 'ready', interval = 20, policy = makePolicy('auto'), stateDir = STATE_DIR,
    github, out = (line) => process.stdout.write(`${line}\n`), log: logger = log, sleep = delay,
  }) {
    Object.assign(this, { repo, pr, until, interval, policy, out, log: logger, sleep });
    this.github = github ?? githubClient(repo, pr);
    this.path = `${stateBase(stateDir, repo, pr)}.json`;
    const state = this.load();
    // First run for this PR: Record what exists and report nothing.
    this.baseline = state === null;
    this.state = { reported: [], summaries: {}, base_oid: null, merge_state: null, ...state };
    this.reported = new Set(this.state.reported);
    this.printed = new Set();
    this.events = 0;
    this.required = null;
    this.prevSnapshot = null;
    this.emptyGate = { head: null, polls: 0 };
    this.prFiles = new Map();
    this.failures = 0;
  }

  load() {
    try {
      if (Date.now() - fs.statSync(this.path).mtimeMs > STALE_STATE_MS) return null;
      const state = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
    } catch {
      return null;
    }
  }

  save() {
    this.state.reported = [...this.reported].sort();
    const tmp = this.path.replace(/\.json$/, '.tmp');
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.path);
  }

  say(line) {
    if (!this.printed.has(line)) {
      this.printed.add(line);
      this.out(`#${this.pr} ${line}`);
    }
  }

  /** Print an event once per PR, across restarts. */
  emit(key, line) {
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    if (this.baseline) return false;
    this.events += 1;
    this.say(line);
    return true;
  }

  finish(code, lines = []) {
    for (const line of lines) this.say(line);
    this.save();
    return new Finish(code);
  }

  /** Files this PR touches that the new base commits also touch. */
  async baseOverlap(head, oldOid, newOid) {
    let moved;
    try {
      if (!this.prFiles.has(head)) this.prFiles.set(head, new Set(await this.github.prFiles()));
      moved = await this.github.compareFiles(oldOid, newOid);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      this.log(`could not compare base commits: ${error.message}`);
      return [];
    }
    const files = this.prFiles.get(head);
    return [...new Set(moved)].filter((f) => files.has(f)).sort();
  }

  /** How far the head is behind its base, for the green and ready lines. */
  async behind(base, baseOid, head) {
    if (!baseOid) return '';
    let count;
    try {
      count = await this.github.behindBy(baseOid, head);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      return '';
    }
    return `; ${count} commit${count === '1' ? '' : 's'} behind ${base}`;
  }

  /** One poll. Throws a Finish when the run should end. */
  async poll() {
    const policy = this.policy;
    const bots = knownBots(policy);
    const nameOf = (text) => botName(text, policy);
    const pr = await this.github.fetchPr();
    if (pr.state === 'MERGED') throw this.finish(0, [`merged: ${pr.url}`]);
    if (pr.state === 'CLOSED') throw this.finish(1, [`closed without merging: ${pr.url}`]);

    const base = pr.baseRefName;
    if (this.required === null) {
      this.required = new Set(await this.github.requiredChecks(base));
      const gate = [...this.required].sort().join(', ') || 'none set, so every CI check gates';
      this.log(`watching ${this.repo}#${this.pr} until ${this.until}; required checks: ${gate}`);
    }
    const checks = collapseChecks(await this.github.checkRows());
    const head = pr.headRefOid;
    const short = head.slice(0, 7);
    const author = who(pr)[0];
    const mine = new Set([author, pr.viewer]);
    const comments = pr.comments.nodes;
    const reviews = pr.reviews.nodes;
    const threads = pr.reviewThreads.nodes;
    this.events = 0;

    // Required checks. With no required checks configured, every CI check
    // gates except the review bots' own checks.
    const gate = this.required.size ? this.required : new Set([...checks.keys()].filter((n) => !nameOf(n)));
    const label = this.required.size ? 'required check' : 'check';
    const bucket = (name) => (checks.has(name) ? checks.get(name).bucket : 'pending');

    const failLines = [];
    for (const name of [...gate].sort()) {
      if (FAILED.includes(bucket(name))) {
        const link = checks.get(name).link;
        failLines.push(`${label} failed: ${name} ${link}`);
        this.emit(`fail:${head}:${name}:${link}`, failLines.at(-1));
      }
    }
    const watched = new Map([...checks].filter(([name]) => !ADVISORY_BOTS.includes(nameOf(name))));
    // A head with no CI checks at all counts as checked once that stays true for
    // a few polls, so CI that registers late is not mistaken for no CI.
    this.emptyGate = gate.size || this.emptyGate.head !== head ? { head, polls: gate.size ? 0 : 1 } : { head, polls: this.emptyGate.polls + 1 };
    const noCi = gate.size === 0 && this.emptyGate.polls >= NO_CI_POLLS;
    const gateDone = noCi || (gate.size > 0 && [...gate].every((n) => bucket(n) !== 'pending'));
    const allDone = gateDone && [...watched.values()].every((c) => c.bucket !== 'pending');
    // Checks appear a few seconds after a push. Two identical polls in a row
    // guard against calling a half-registered set of checks finished.
    const snapshot = JSON.stringify([
      head,
      ...[...watched].map(([name, c]) => [name, c.bucket]).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1])),
    ]);
    const stable = snapshot === this.prevSnapshot;
    this.prevSnapshot = snapshot;
    const green = gateDone && stable && failLines.length === 0;

    // People and bots talking. Edits are never events.
    let feedback = 0;
    for (const comment of comments) {
      const [login, isBot] = who(comment);
      if (mine.has(login) || nameOf(login) || (isBot && STATUS_BOTS.some((b) => login.includes(b)))) continue;
      if (this.emit(`c:${comment.id}`, `comment from ${login}: ${snippet(comment.body)} ${comment.url}`)) feedback += 1;
    }
    for (const review of reviews) {
      const [login, isBot] = who(review);
      if (mine.has(login) || isBot) continue;
      if (['APPROVED', 'CHANGES_REQUESTED'].includes(review.state) || (review.body || '').trim()) {
        const state = review.state.toLowerCase().replaceAll('_', ' ');
        if (this.emit(`c:${review.id}`, `review from ${login} (${state}): ${snippet(review.body)} ${review.url}`)) feedback += 1;
      }
    }
    const latest = new Map();
    for (const review of reviews) {
      const [login, isBot] = who(review);
      // Readiness counts every human reviewer except the PR author, the watcher included.
      if (!isBot && login !== author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
        latest.set(login, review.state);
      }
    }
    const changesRequested = [...latest].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([l]) => l).sort();
    const requested = (pr.reviewRequests?.nodes ?? []).map((node) => (node.requestedReviewer?.login || '').toLowerCase());
    const unresolved = [];
    for (const thread of threads) {
      const nodes = thread.comments.nodes;
      if (!thread.isResolved && nodes.length) unresolved.push(nodes[0].url);
      const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      nodes.forEach((comment, index) => {
        const [login] = who(comment);
        if (mine.has(login)) return;
        const kind = index === 0 ? 'new thread' : 'thread reply';
        if (this.emit(`c:${comment.id}`, `${kind} from ${login} on ${where}: ${snippet(comment.body)} ${comment.url}`)) feedback += 1;
      });
    }

    // Review bots on the current head. A bot with checks is done when they
    // finish. Otherwise it is done once it reviews the head commit or its
    // summary names the head.
    const botStatus = new Map();
    const waiting = [];
    const botFailures = [];
    for (const bot of bots) {
      const ownChecks = [...checks].filter(([name]) => nameOf(name) === bot);
      const summaries = comments.filter((c) => nameOf(who(c)[0]) === bot);
      const ownReviews = reviews.filter((r) => nameOf(who(r)[0]) === bot);
      const onHead = ownReviews.some((r) => r.commit?.oid === head);
      const isRequested = requested.some((login) => login.includes(bot));
      let done;
      if (ownChecks.length) done = ownChecks.every(([, c]) => c.bucket !== 'pending');
      else if (REQUEST_DRIVEN_BOTS.includes(bot)) done = onHead || (ownReviews.length > 0 && !isRequested);
      else done = onHead || summaries.some((s) => (s.body || '').includes(short));
      const seen = ownChecks.length > 0 || summaries.length > 0 || ownReviews.length > 0 || isRequested;
      const gating = policy.gating.includes(bot);
      const advisory = ADVISORY_BOTS.includes(bot);
      if (gating && !done && (policy.explicit || seen)) waiting.push(bot);
      if (gating && done) {
        for (const [name, c] of ownChecks) {
          if (FAILED.includes(c.bucket)) botFailures.push(`review bot check failed: ${name} ${c.link}`);
        }
      }
      if (advisory && ownChecks.length) {
        const desc = ownChecks[0][1];
        botStatus.set(bot, `${bot} ${desc.description || desc.bucket} (advisory)`);
      } else if (seen) {
        botStatus.set(bot, `${bot} ${done ? 'done' : 'pending'}${advisory ? ' (advisory)' : ''}`);
      }
      const key = `bot:${bot}:${head}`;
      const wasDone = this.reported.has(key);
      if (done && seen && (onHead || !REQUEST_DRIVEN_BOTS.includes(bot))) {
        const failed = ownChecks.filter(([, c]) => FAILED.includes(c.bucket)).map(([name]) => name);
        const detail = [
          summaries.map((s) => verdict(s.body)).find(Boolean) ?? '',
          failed.length ? `failed: ${failed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        const tag = advisory ? ' (advisory, not waited on)' : '';
        this.emit(key, `${bot} finished on ${short}${detail ? `: ${detail}` : ''}${tag}`);
      }
      if (gating) {
        for (const s of summaries) {
          const fresh = digest(s.body);
          const old = this.state.summaries[s.id];
          this.state.summaries[s.id] = fresh;
          if (wasDone && old && old !== fresh) {
            const text = verdict(s.body) || snippet(s.body);
            this.emit(`summary:${s.id}:${fresh}`, `${bot} summary changed on ${short}: ${text} ${s.url}`);
          }
        }
      }
    }

    // Base branch and merge state.
    const baseOid = pr.baseRef?.target?.oid ?? null;
    const oldBase = this.state.base_oid;
    if (baseOid && oldBase && baseOid !== oldBase && !this.baseline) {
      const touched = await this.baseOverlap(head, oldBase, baseOid);
      if (touched.length) {
        const more = touched.length > 5 ? ` and ${touched.length - 5} more` : '';
        this.emit(
          `base:${baseOid}`,
          `${base} moved to ${baseOid.slice(0, 7)} and touches files in this PR: ${touched.slice(0, 5).join(', ')}${more}`,
        );
      }
    }
    if (baseOid) this.state.base_oid = baseOid;
    const mergeState = pr.mergeStateStatus;
    const dirtyLine = `merge state is DIRTY: the branch conflicts with ${base}, rebase it`;
    const behindLine = `merge state is BEHIND: update the branch from ${base} before merging`;
    if (mergeState !== 'UNKNOWN') {
      if ((mergeState === 'BEHIND' || mergeState === 'DIRTY') && this.state.merge_state !== mergeState) {
        this.emit(`merge:${mergeState}:${head}:${baseOid ?? 'None'}`, mergeState === 'DIRTY' ? dirtyLine : behindLine);
      }
      this.state.merge_state = mergeState;
    }

    // One summary line per head once all checks finish.
    const counts = new Map();
    for (const c of watched.values()) counts.set(c.bucket, (counts.get(c.bucket) ?? 0) + 1);
    const failedNames = [...watched].filter(([, c]) => FAILED.includes(c.bucket)).map(([n]) => n).sort();
    const greenRequired = [...this.required].filter((n) => ['pass', 'skipping'].includes(bucket(n))).length;
    const parts = [
      [...counts].sort((a, b) => cmp(a[0], b[0])).map(([b, n]) => `${n} ${b}`).join(', ') +
        (failedNames.length ? ` (${failedNames.join(', ')})` : ''),
      this.required.size ? `required ${greenRequired}/${this.required.size} green` : '',
      bots.filter((b) => botStatus.has(b)).map((b) => botStatus.get(b)).join(', ') || 'no review bots yet',
      `${unresolved.length} unresolved threads`,
      `merge state ${mergeState}`,
    ];
    const summary = parts.filter(Boolean).join('; ');
    const checksKey = `checks:${head}`;

    // Decide whether to stop. A green or ready line carries the same summary
    // as the checks line, so it marks that event as reported.
    if (this.until !== 'any-change') {
      if (mergeState === 'DIRTY') throw this.finish(1, [dirtyLine]);
      if (failLines.length) throw this.finish(1, failLines);
      // New feedback wakes the owner right away, even while CI or bots are still running.
      if (feedback) throw this.finish(1, [`${feedback} new review ${feedback === 1 ? 'item' : 'items'} on ${short}: handle them, then restart the watcher`]);
      if (botFailures.length) throw this.finish(1, botFailures);
      if (green && this.until === 'green') {
        this.reported.add(checksKey);
        throw this.finish(0, [`green on ${short}: ${summary}${await this.behind(base, baseOid, head)}`]);
      }
      // ready waits for expected review bots, never for CodeRabbit.
      if (green && waiting.length === 0) {
        if (unresolved.length) {
          throw this.finish(1, [`blocked by ${unresolved.length} unresolved threads on ${short}: ${unresolved.join(' ')}`]);
        }
        if (changesRequested.length) {
          throw this.finish(1, [`changes requested by ${changesRequested.join(', ')} on ${short}`]);
        }
        if (mergeState === 'BEHIND') throw this.finish(1, [behindLine]);
        this.reported.add(checksKey);
        throw this.finish(0, [`ready on ${short}: ${summary}${await this.behind(base, baseOid, head)}`]);
      }
    }
    if (allDone && (stable || this.baseline)) this.emit(checksKey, `checks finished on ${short}: ${summary}`);
    if (this.until === 'any-change' && this.events) throw this.finish(0);
  }

  /** One poll plus bookkeeping. Returns an exit code when the run should end, else null. */
  async step() {
    try {
      await this.poll();
      this.failures = 0;
    } catch (error) {
      if (error instanceof Finish) return error.code;
      if (!(error instanceof GhError)) throw error;
      if (!error.transient) return this.finish(1, [`pr-wait stopped: ${error.message}`]).code;
      this.failures += 1;
      this.log(`poll failed (${this.failures}/${MAX_FAILED_POLLS}): ${error.message}`);
      if (this.failures >= MAX_FAILED_POLLS) {
        return this.finish(1, [`pr-wait stopped: GitHub unreachable for ${this.failures} polls: ${error.message}`]).code;
      }
      return null;
    }
    this.save();
    if (this.baseline) this.log(`baseline recorded for ${this.repo}#${this.pr}; reporting only new events`);
    this.baseline = false;
    return null;
  }

  async run() {
    for (;;) {
      const code = await this.step();
      if (code !== null) return code;
      await this.sleep(this.interval * 1000);
    }
  }
}

// Code point order, like Python's sorted() on str.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- CLI -----------------------------------------------------------------------------

const USAGE = `usage: pr-wait [-h] [--repo REPO] [--until {green,ready,any-change}]
               [--interval INTERVAL] [--review-bots REVIEW_BOTS]
               [pr]`;

const HELP = `${USAGE}

Watch a GitHub PR and print one line per real event.

positional arguments:
  pr                    PR number or URL

options:
  -h, --help            show this help message and exit
  --repo REPO           owner/name (default: from the URL or the current
                        checkout)
  --until {green,ready,any-change}
  --interval INTERVAL   seconds between polls (default 20, min 5)
  --review-bots REVIEW_BOTS
                        auto, none, or a comma-separated list of bot logins
`;

export class UsageError extends Error {}

const OPTIONS = ['--help', '--repo', '--until', '--interval', '--review-bots'];
const UNTIL = ['green', 'ready', 'any-change'];
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

/** Parse argv like Python's argparse did. Throws UsageError, or returns {help: true}. */
export function parseArgs(argv) {
  const args = { pr: undefined, repo: undefined, until: 'ready', interval: 20, reviewBots: 'auto' };
  const positionals = [];
  const extras = [];
  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (onlyPositionals || !token.startsWith('-') || token === '-' || NEGATIVE_NUMBER.test(token)) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    if (token === '-h') return { help: true };
    if (!token.startsWith('--')) {
      extras.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const exact = OPTIONS.includes(flag) ? [flag] : OPTIONS.filter((o) => o.startsWith(flag));
    if (exact.length > 1) throw new UsageError(`ambiguous option: ${flag} could match ${exact.join(', ')}`);
    if (exact.length === 0) {
      extras.push(token);
      continue;
    }
    const option = exact[0];
    if (option === '--help') return { help: true };
    let value;
    if (eq !== -1) value = token.slice(eq + 1);
    else if (i + 1 < argv.length && (!argv[i + 1].startsWith('-') || argv[i + 1] === '-' || NEGATIVE_NUMBER.test(argv[i + 1]))) value = argv[++i];
    else throw new UsageError(`argument ${option}: expected one argument`);
    if (option === '--repo') args.repo = value;
    else if (option === '--review-bots') args.reviewBots = value;
    else if (option === '--until') {
      if (!UNTIL.includes(value)) {
        throw new UsageError(`argument --until: invalid choice: '${value}' (choose from ${UNTIL.map((u) => `'${u}'`).join(', ')})`);
      }
      args.until = value;
    } else if (option === '--interval') {
      if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) throw new UsageError(`argument --interval: invalid int value: '${value}'`);
      args.interval = Number(value.trim().replaceAll('_', ''));
    }
  }
  if (positionals.length) args.pr = positionals.shift();
  extras.push(...positionals);
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(' ')}`);
  return args;
}

/** Run the CLI. Returns the exit code. */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${USAGE}\npr-wait: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const policy = makePolicy(args.reviewBots);
  let release = () => {};
  const cleanup = () => release();
  process.on('exit', cleanup);
  const onSignal = (code) => () => {
    cleanup();
    process.exit(code);
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  try {
    const [repo, pr] = await parseTarget(args.pr, args.repo);
    release = acquireLock(repo, pr);
    return await new Watcher({ repo, pr, until: args.until, interval: Math.max(args.interval, 5), policy }).run();
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    process.stdout.write(`pr-wait: ${error.message}\n`);
    return error.code;
  } finally {
    cleanup();
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
