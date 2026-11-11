import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GhError,
  Watcher,
  acquireLock,
  botName,
  canonicalBot,
  collapseChecks,
  knownBots,
  makePolicy,
  parseArgs,
  snippet,
} from '../skills/babysit/scripts/pr-wait.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'skills', 'babysit', 'scripts', 'pr-wait.mjs');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

let root;
let counter = 0;
before(() => {
  root = fs.mkdtempSync(path.join(here, '.pr-wait-state-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const user = (login) => ({ login, __typename: 'User' });
const bot = (login) => ({ login, __typename: 'Bot' });
let ids = 0;
const review = (author, state, oid = HEAD, body = '') => ({
  id: `R${++ids}`, url: `https://github.com/o/r/pull/1#r${ids}`, state, body, commit: { oid }, author,
});

function makePr({ comments = [], reviews = [], threads = [], requested = [], mergeState = 'CLEAN', author = 'octocat', viewer = 'octocat' } = {}) {
  return {
    url: 'https://github.com/o/r/pull/1', state: 'OPEN', headRefOid: HEAD, baseRefName: 'main',
    mergeStateStatus: mergeState, author: user(author), baseRef: null, viewer,
    reviewRequests: { nodes: requested.map((login) => ({ requestedReviewer: { login } })) },
    comments: { nodes: comments }, reviews: { nodes: reviews }, reviewThreads: { nodes: threads },
  };
}

const ci = { name: 'build', bucket: 'pass', link: 'https://ci/build', description: '' };

/** Run up to `polls` watcher steps against fake GitHub data. code is null while still waiting. */
async function watch({ pr = makePr(), checks = [ci], reviewBots = 'auto', until = 'ready', polls = 3 } = {}) {
  const lines = [];
  const watcher = new Watcher({
    repo: 'o/r', pr: 1, until, policy: makePolicy(reviewBots), stateDir: path.join(root, String(++counter)),
    out: (line) => lines.push(line), log: () => {}, sleep: async () => {},
    github: {
      fetchPr: async () => structuredClone(pr),
      checkRows: async () => structuredClone(checks),
      requiredChecks: async () => [],
      prFiles: async () => [],
      compareFiles: async () => [],
      behindBy: async () => '0',
    },
  });
  for (let i = 0; i < polls; i++) {
    const code = await watcher.step();
    if (code !== null) return { code, lines };
  }
  return { code: null, lines };
}

const READY = '#1 ready on aaaaaaa';

describe('readiness', () => {
  test('no bots, checks green, clean: ready', async () => {
    const { code, lines } = await watch();
    assert.equal(code, 0);
    assert.deepEqual(lines, [`${READY}: 1 pass; no review bots yet; 0 unresolved threads; merge state CLEAN`]);
  });

  test('copilot requested but not reviewed: keeps waiting', async () => {
    const { code } = await watch({ pr: makePr({ requested: ['Copilot-Pull-Request-Reviewer'] }) });
    assert.equal(code, null);
  });

  test('copilot reviewed the head: ready', async () => {
    const pr = makePr({ reviews: [review(bot('copilot-pull-request-reviewer'), 'COMMENTED')] });
    const { code, lines } = await watch({ pr });
    assert.equal(code, 0);
    assert.match(lines.at(-1), /^#1 ready on aaaaaaa: .*copilot-pull-request-reviewer done/);
  });

  test('copilot reviewed an old head and is not re-requested: ready', async () => {
    const pr = makePr({ reviews: [review(bot('copilot-pull-request-reviewer'), 'COMMENTED', OLD)] });
    const { code, lines } = await watch({ pr });
    assert.equal(code, 0);
    assert.ok(lines.at(-1).startsWith(READY));
  });

  test('copilot reviewed an old head and is re-requested: keeps waiting', async () => {
    const pr = makePr({
      reviews: [review(bot('copilot-pull-request-reviewer'), 'COMMENTED', OLD)],
      requested: ['copilot-pull-request-reviewer'],
    });
    assert.equal((await watch({ pr })).code, null);
  });

  test('human requests changes: blocked', async () => {
    const pr = makePr({ reviews: [review(user('alice'), 'CHANGES_REQUESTED')] });
    const { code, lines } = await watch({ pr });
    assert.equal(code, 1);
    assert.equal(lines.at(-1), '#1 changes requested by alice on aaaaaaa');
  });

  test('changes requested then approved by the same human: ready', async () => {
    const pr = makePr({ reviews: [review(user('alice'), 'CHANGES_REQUESTED'), review(user('alice'), 'APPROVED')] });
    const { code, lines } = await watch({ pr });
    assert.equal(code, 0);
    assert.ok(lines.at(-1).startsWith(READY));
  });

  test('unresolved thread: blocked', async () => {
    const thread = {
      isResolved: false, path: 'a.js', line: 3,
      comments: { nodes: [{ id: 'T1', url: 'https://t/1', body: 'nit', author: user('bob') }] },
    };
    const { code, lines } = await watch({ pr: makePr({ threads: [thread] }) });
    assert.equal(code, 1);
    assert.equal(lines.at(-1), '#1 blocked by 1 unresolved threads on aaaaaaa: https://t/1');
  });

  test('explicit --review-bots greptile never seen: keeps waiting', async () => {
    assert.equal((await watch({ reviewBots: 'greptile' })).code, null);
  });

  test('auto mode with a pending Greptile check: keeps waiting', async () => {
    const checks = [ci, { name: 'Greptile Review', bucket: 'pending', link: '', description: '' }];
    assert.equal((await watch({ checks })).code, null);
  });

  test('merge state BEHIND: blocked', async () => {
    const { code, lines } = await watch({ pr: makePr({ mergeState: 'BEHIND' }) });
    assert.equal(code, 1);
    assert.equal(lines.at(-1), '#1 merge state is BEHIND: update the branch from main before merging');
  });

  test('--review-bots none with a pending Greptile check: ready, and the bot check does not gate', async () => {
    const checks = [ci, { name: 'Greptile Review', bucket: 'pending', link: '', description: '' }];
    const { code, lines } = await watch({ checks, reviewBots: 'none' });
    assert.equal(code, 0);
    assert.equal(lines.at(-1), `${READY}: 1 pass, 1 pending; greptile pending; 0 unresolved threads; merge state CLEAN`);
  });

  test('--review-bots copilot with an old review, not requested: ready', async () => {
    const pr = makePr({ reviews: [review(bot('copilot-pull-request-reviewer'), 'COMMENTED', OLD)] });
    assert.equal((await watch({ pr, reviewBots: 'copilot' })).code, 0);
  });

  test('--review-bots copilot never seen: keeps waiting', async () => {
    assert.equal((await watch({ reviewBots: 'copilot' })).code, null);
  });

  test("the viewer's own CHANGES_REQUESTED on someone else's PR: blocked", async () => {
    const pr = makePr({ author: 'carol', viewer: 'octocat', reviews: [review(user('octocat'), 'CHANGES_REQUESTED')] });
    const { code, lines } = await watch({ pr });
    assert.equal(code, 1);
    assert.equal(lines.at(-1), '#1 changes requested by octocat on aaaaaaa');
  });

  test("the PR author's own review is ignored: ready", async () => {
    const pr = makePr({ author: 'octocat', viewer: 'dave', reviews: [review(user('octocat'), 'CHANGES_REQUESTED')] });
    assert.equal((await watch({ pr })).code, 0);
  });

  test('a single poll is never green: checks must be stable across two polls', async () => {
    assert.equal((await watch({ polls: 1 })).code, null);
  });

  test('--until green ignores pending review bots', async () => {
    const { code, lines } = await watch({ until: 'green', pr: makePr({ requested: ['copilot-pull-request-reviewer'] }) });
    assert.equal(code, 0);
    assert.match(lines.at(-1), /^#1 green on aaaaaaa: /);
  });
});

describe('events and state', () => {
  test('first run is a baseline; a restarted watcher reports only new events', async () => {
    const stateDir = path.join(root, 'restart');
    const comment = (id, login) => ({ id, url: `https://c/${id}`, body: `hello <b>&amp;</b> ${id}`, author: user(login) });
    let pr = makePr({ comments: [comment('C1', 'erin')], requested: ['copilot-pull-request-reviewer'] });
    const lines = [];
    const make = () => new Watcher({
      repo: 'o/r', pr: 1, stateDir, policy: makePolicy('auto'), out: (l) => lines.push(l), log: () => {},
      github: { fetchPr: async () => structuredClone(pr), checkRows: async () => [ci], requiredChecks: async () => [] },
    });
    assert.equal(await make().step(), null);
    assert.deepEqual(lines, []);
    pr = makePr({ comments: [comment('C1', 'erin'), comment('C2', 'frank')], requested: ['copilot-pull-request-reviewer'] });
    assert.equal(await make().step(), 1, 'new feedback wakes the owner');
    assert.deepEqual(lines, ['#1 comment from frank: hello & C2 https://c/C2', '#1 1 new review item on aaaaaaa: handle them, then restart the watcher']);
  });

  test('a stale state file starts a fresh baseline', async () => {
    const stateDir = path.join(root, 'stale');
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, 'o__r__1.json');
    fs.writeFileSync(file, JSON.stringify({ reported: [], summaries: {}, base_oid: null, merge_state: null }));
    const old = new Date(Date.now() - 7 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    assert.equal(new Watcher({ repo: 'o/r', pr: 1, stateDir, github: {} }).baseline, true);
    fs.utimesSync(file, new Date(), new Date());
    assert.equal(new Watcher({ repo: 'o/r', pr: 1, stateDir, github: {} }).baseline, false);
  });

  test('transient failures are retried by the run loop; merged PR exits 0', async () => {
    const lines = [];
    let calls = 0;
    const watcher = new Watcher({
      repo: 'o/r', pr: 1, stateDir: path.join(root, 'transient'), out: (l) => lines.push(l), log: () => {},
      sleep: async () => {},
      github: {
        fetchPr: async () => {
          if (++calls === 1) throw new GhError('HTTP 502', true);
          return { ...makePr(), state: 'MERGED' };
        },
      },
    });
    assert.equal(await watcher.run(), 0);
    assert.deepEqual(lines, ['#1 merged: https://github.com/o/r/pull/1']);
  });

  test('a non-transient failure stops with exit 1', async () => {
    const lines = [];
    const watcher = new Watcher({
      repo: 'o/r', pr: 1, stateDir: path.join(root, 'fatal'), out: (l) => lines.push(l), log: () => {},
      github: { fetchPr: async () => { throw new GhError('HTTP 401: Bad credentials', false); } },
    });
    assert.equal(await watcher.run(), 1);
    assert.deepEqual(lines, ['#1 pr-wait stopped: HTTP 401: Bad credentials']);
  });
});

describe('helpers', () => {
  test('bot policy', () => {
    assert.equal(canonicalBot(' Copilot '), 'copilot-pull-request-reviewer');
    assert.equal(canonicalBot('acme-bot'), 'acme-bot');
    assert.deepEqual(makePolicy('copilot,greptile,copilot'), { gating: ['copilot-pull-request-reviewer', 'greptile'], explicit: true });
    assert.deepEqual(makePolicy('none'), { gating: [], explicit: false });
    assert.ok(knownBots(makePolicy('acme-bot')).includes('acme-bot'));
    assert.equal(botName('Greptile Review', makePolicy('none')), 'greptile');
    assert.equal(botName('build', makePolicy('auto')), null);
  });

  test('duplicate checks collapse to the worst bucket', () => {
    const checks = collapseChecks([
      { name: 'build', bucket: 'pass' }, { name: 'lint', bucket: 'pass' }, { name: 'build', bucket: 'fail' },
    ]);
    assert.deepEqual([...checks].map(([n, c]) => `${n}:${c.bucket}`), ['build:fail', 'lint:pass']);
  });

  test('snippet strips markup and truncates', () => {
    assert.equal(snippet('<!-- x -->a&nbsp;&lt;b&gt;\n\n  c'), 'a <b> c');
    assert.equal(snippet('x'.repeat(120)), `${'x'.repeat(97)}...`);
  });

  test('argument parsing', () => {
    assert.deepEqual(parseArgs(['12', '--int=30', '--until', 'green']), {
      pr: '12', repo: undefined, until: 'green', interval: 30, reviewBots: 'auto',
    });
    assert.throws(() => parseArgs(['--until', 'x']), /invalid choice: 'x'/);
    assert.throws(() => parseArgs(['--interval', 'x']), /invalid int value: 'x'/);
    assert.throws(() => parseArgs(['--re', 'a/b']), /ambiguous option/);
    assert.throws(() => parseArgs(['1', '2']), /unrecognized arguments: 2/);
    assert.throws(() => parseArgs(['--repo']), /expected one argument/);
  });
});

describe('cli and lock', () => {
  test('a lock held by a live pid stops a second watcher; a dead pid is taken over', () => {
    const stateDir = path.join(root, 'lock');
    const release = acquireLock('o/r', 7, { stateDir });
    const lockFile = path.join(stateDir, 'o__r__7.lock');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid));
    assert.throws(() => acquireLock('o/r', 7, { stateDir }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.message, new RegExp(`^pid ${process.pid} already watches o/r#7`));
      return true;
    });
    release();
    assert.equal(fs.existsSync(lockFile), false);

    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    fs.writeFileSync(lockFile, dead);
    acquireLock('o/r', 7, { stateDir })();
    assert.equal(fs.existsSync(lockFile), false);
  });

  test('a bad PR argument exits 2', () => {
    const result = spawnSync(process.execPath, [script, 'abc'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "pr-wait: 'abc' is not a PR number or PR URL\n");
  });

  test('a bad option exits 2 with usage on stderr', () => {
    const result = spawnSync(process.execPath, [script, '1', '--until', 'x'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: pr-wait .*\npr-wait: error: argument --until: invalid choice/s);
  });
});

describe('review fixes', () => {
  /** A watcher whose fake GitHub data can change between polls. */
  function live(state) {
    const lines = [];
    const watcher = new Watcher({
      repo: 'o/r', pr: 1, policy: makePolicy('auto'), stateDir: path.join(root, String(++counter)),
      out: (line) => lines.push(line), log: () => {}, sleep: async () => {},
      github: {
        fetchPr: async () => structuredClone(state.pr),
        checkRows: async () => structuredClone(state.checks),
        requiredChecks: async () => [],
        prFiles: async () => [],
        compareFiles: async () => [],
        behindBy: async () => '0',
      },
    });
    return { watcher, lines };
  }

  test('a failed review-bot check needs action instead of counting as a review', async () => {
    const greptile = { name: 'Greptile Review', bucket: 'fail', link: 'https://ci/greptile', description: '' };
    const { code, lines } = await watch({ checks: [ci, greptile] });
    assert.equal(code, 1);
    assert.match(lines.at(-1), /review bot check failed: Greptile Review/);
  });

  test('a PR with no CI at all becomes ready after a few quiet polls', async () => {
    assert.equal((await watch({ checks: [], polls: 2 })).code, null);
    const { code, lines } = await watch({ checks: [], polls: 5 });
    assert.equal(code, 0);
    assert.match(lines.at(-1), /^#1 ready on aaaaaaa/);
  });

  test('the first poll of a new head is never ready, even with identical check results', async () => {
    const state = { pr: { ...makePr({ requested: ['copilot-pull-request-reviewer'] }), headRefOid: OLD }, checks: [ci] };
    const { watcher } = live(state);
    assert.equal(await watcher.step(), null);
    assert.equal(await watcher.step(), null);
    state.pr = makePr({ reviews: [review(bot('copilot-pull-request-reviewer'), 'COMMENTED', HEAD)] });
    assert.equal(await watcher.step(), null, 'new head: checks may not have registered yet');
    assert.equal(await watcher.step(), 0);
  });

  test('new feedback wakes the owner while CI is still running', async () => {
    const state = { pr: makePr(), checks: [{ ...ci, bucket: 'pending' }] };
    const { watcher, lines } = live(state);
    assert.equal(await watcher.step(), null);
    state.pr = makePr({ comments: [{ id: 'C9', url: 'https://c/C9', body: 'please rename', author: user('dana') }] });
    assert.equal(await watcher.step(), 1);
    assert.deepEqual(lines, ['#1 comment from dana: please rename https://c/C9', '#1 1 new review item on aaaaaaa: handle them, then restart the watcher']);
  });
});
