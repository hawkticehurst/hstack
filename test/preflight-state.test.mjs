import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../skills/preflight/scripts/preflight-state.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'preflight-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

let work;
let upstream;
let findingsCount = 0;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const state = (cwd, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const write = (cwd, path, text) => {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), text);
};
const findings = rows => {
	const path = join(root, `findings-${findingsCount++}.json`);
	writeFileSync(path, JSON.stringify(rows));
	return path;
};
const lines = (n, last = n) => Array.from({ length: n }, (_, i) => (i + 1 === n ? last : i + 1)).join('\n') + '\n';

function clone(dir) {
	git(root, 'clone', '-q', join(root, 'origin.git'), dir);
	git(dir, 'config', 'user.email', 't@t');
	git(dir, 'config', 'user.name', 't');
	return dir;
}

function pushUpstream(edit) {
	git(upstream, 'pull', '-q', 'origin', 'main');
	edit(upstream);
	git(upstream, 'commit', '-qam', 'upstream');
	git(upstream, 'push', '-q', 'origin', 'HEAD:main');
	git(work, 'fetch', '-q');
	git(work, 'rebase', '-q', 'origin/main');
}

beforeEach(() => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root);
	git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
	work = clone(join(root, 'work'));
	write(work, 'src/big.ts', lines(995));
	write(work, 'src/other.ts', 'a\n');
	write(work, 'unrelated.txt', 'z\n');
	write(work, 'run.sh', 'echo\n');
	git(work, 'add', '-A');
	git(work, 'commit', '-qm', 'base');
	git(work, 'push', '-q', 'origin', 'HEAD:main');
	git(work, 'remote', 'set-head', 'origin', 'main');
	git(work, 'checkout', '-qb', 'feature');
	upstream = clone(join(root, 'upstream'));
});

describe('size', () => {
	test('splits prod and tests and flags a file crossing 1000 lines', () => {
		write(work, 'src/big.ts', lines(1005));
		git(work, 'add', 'src/big.ts');
		write(work, 'src/other.ts', 'a\nb\n');
		write(work, 'src/foo.test.ts', 'one\ntwo\nthree\n');
		const out = state(work, 'size').stdout;
		assert.match(out, /files: 3 changed \(1 untracked\)/);
		assert.match(out, /prod \+11 -0, tests \+3 -0/);
		assert.match(out, /src\/big\.ts: 995 -> 1005 lines \(crossed 1000\)/);
	});
});

describe('save and check', () => {
	test('check fails without a record', () => {
		const result = state(work, 'check');
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no preflight review recorded/);
	});

	test('ready is refused while a should finding is open', () => {
		write(work, 'src/other.ts', 'changed\n');
		const result = state(work, 'save', '--verdict', 'ready', '--findings', findings([{ id: 'trim-1', reviewer: 'trim', severity: 'should', outcome: 'open' }]));
		assert.equal(result.status, 2);
		assert.match(result.stderr, /open: trim-1/);
	});

	test('a fix verdict never passes check', () => {
		write(work, 'src/other.ts', 'changed\n');
		assert.equal(state(work, 'save', '--verdict', 'fix').status, 0);
		const result = state(work, 'check');
		assert.equal(result.status, 1);
		assert.match(result.stderr, /verdict is fix/);
	});

	test('stays fresh across a commit, a reverted edit, and a rebase onto unrelated changes', () => {
		write(work, 'src/other.ts', 'changed\n');
		write(work, 'src/new.ts', 'new\n');
		assert.equal(state(work, 'save', '--verdict', 'ready').status, 0);
		assert.equal(state(work, 'check').status, 0);

		git(work, 'add', '-A');
		git(work, 'commit', '-qm', 'feature');
		assert.equal(state(work, 'check').status, 0, 'commit keeps it fresh');

		write(work, 'src/other.ts', 'changed again\n');
		assert.equal(state(work, 'check').status, 1, 'an edit makes it stale');
		write(work, 'src/other.ts', 'changed\n');
		assert.equal(state(work, 'check').status, 0, 'reverting the edit makes it fresh again');

		pushUpstream(dir => write(dir, 'unrelated.txt', 'y\n'));
		assert.equal(state(work, 'check').status, 0, 'rebase onto an unrelated change keeps it fresh');
	});

	test('goes stale when upstream changes a reviewed file', () => {
		write(work, 'src/big.ts', lines(995, 'feature'));
		git(work, 'commit', '-qam', 'feature');
		assert.equal(state(work, 'save', '--verdict', 'ready').status, 0);
		pushUpstream(dir => write(dir, 'src/big.ts', 'upstream\n' + lines(995).split('\n').slice(1).join('\n')));
		assert.equal(state(work, 'check').status, 1);
	});

	test('goes stale when a symlink is retargeted, and handles dangling links', () => {
		write(work, 'one.txt', 'same\n');
		write(work, 'two.txt', 'same\n');
		symlinkSync('one.txt', join(work, 'link'));
		assert.equal(state(work, 'save', '--verdict', 'ready').status, 0);
		rmSync(join(work, 'link'));
		symlinkSync('two.txt', join(work, 'link'));
		assert.equal(state(work, 'check').status, 1, 'same content, different target');
		rmSync(join(work, 'link'));
		symlinkSync('missing.txt', join(work, 'link'));
		assert.equal(state(work, 'save', '--verdict', 'ready').status, 0, 'dangling link');
		assert.equal(state(work, 'check').status, 0);
	});

	test('goes stale when a changed file mode changes', () => {
		write(work, 'run.sh', 'echo hi\n');
		assert.equal(state(work, 'save', '--verdict', 'ready').status, 0);
		chmodSync(join(work, 'run.sh'), 0o755);
		assert.equal(state(work, 'check').status, 1);
		chmodSync(join(work, 'run.sh'), 0o644);
		assert.equal(state(work, 'check').status, 0);
	});

	test('records are per worktree and history is shared', () => {
		const other = join(root, 'other');
		git(work, 'worktree', 'add', '-q', '-b', 'two', other, 'origin/main');
		write(other, 'g.txt', 'y\n');
		const rows = findings([{ id: 'bug-1', reviewer: 'correctness,tests', severity: 'blocker', outcome: 'fixed' }]);
		assert.equal(state(other, 'save', '--verdict', 'ready', '--findings', rows).status, 0);
		assert.equal(state(other, 'check').status, 0);
		assert.equal(state(work, 'check').status, 1);
		const stats = state(work, 'stats').stdout;
		assert.match(stats, /^correctness\s+1\s+1/m);
		assert.match(stats, /^tests\s+1\s+1/m);
	});
});

describe('snapshot and delta', () => {
	test('gates tags an untracked skipped test and a staged ts-ignore', () => {
		write(work, 'src/other.ts', '// @ts-ignore\na\n');
		git(work, 'add', 'src/other.ts');
		write(work, 'src/new.test.ts', "suite.skip('x', () => {});\n");
		const out = state(work, 'gates').stdout;
		assert.match(out, /^gate hunks: 2 tagged/);
		assert.match(out, /\[RH-13\] src\/other\.ts:1/);
		assert.match(out, /\[RH-1\] src\/new\.test\.ts:1/);
	});

	test('delta shows edits since the snapshot without touching the index', () => {
		write(work, 'src/other.ts', 'staged\n');
		git(work, 'add', 'src/other.ts');
		const before = git(work, 'status', '--porcelain');
		const tree = state(work, 'snapshot', '--base', 'origin/main').stdout.trim();
		assert.equal(git(work, 'status', '--porcelain'), before);
		write(work, 'src/new.ts', 'new\n');
		const delta = state(work, 'delta', tree).stdout;
		assert.match(delta, /diff --git a\/src\/new\.ts/);
		assert.doesNotMatch(delta, /src\/other\.ts/);
	});
});
