import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../skills/distill/scripts/ledger.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ledger-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

let home;
let heap;
let patches = 0;
const ledger = (...args) => spawnSync('node', [SCRIPT, ...args, '--topic', 't'], {
	encoding: 'utf8',
	env: { ...process.env, HSTACK_DESIGN_HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});
const ok = (...args) => {
	const result = ledger(...args);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
};
const apply = (ops, ...flags) => {
	const path = join(root, `patch-${patches++}.json`);
	writeFileSync(path, JSON.stringify({ ops }));
	return ledger('apply', path, ...flags);
};
const show = id => ok('show', id);
const said = (src, quote, speaker = 'user', ref) => ({ op: 'evidence', src, quote, kind: 'said', speaker, ref });

beforeEach(() => {
	home = join(root, `home-${patches++}`);
	heap = join(root, `heap-${patches++}`);
	mkdirSync(heap);
	writeFileSync(join(heap, 'a.md'), 'Interview A: \u201cI never know   which session\nis still running.\u201d\n');
	writeFileSync(join(heap, 'b.md'), 'Issue B: I have six sessions open and no idea which one finished.\n');
	writeFileSync(join(heap, 'c.md'), 'Support ticket C: Customer cannot tell which agent session is waiting.\n');
	writeFileSync(join(heap, 'd.md'), 'Spec D: The sessions list shows a spinner for running sessions.\n');
	ok('init');
	ok('run', 'start');
	ok('scan', heap);
});

describe('apply', () => {
	test('rejects a quote that is not in the source and writes nothing', () => {
		const result = apply([said('S-2', 'six sessions open'), said('S-2', 'twelve sessions open')]);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /op 2 \(evidence\): quote is not verbatim in S-2/);
		assert.match(ok('evidence'), /^0 evidence quotes/m);

		assert.equal(apply([said('S-2', 'six sessions open'), said('S-2', 'twelve sessions open')], '--drop-invalid').status, 0);
		assert.match(ok('evidence'), /^1 evidence quotes/m);
	});

	test('matches quotes across curly quotes and line breaks', () => {
		const result = apply([said('S-1', '"I never know which session is still running."')]);
		assert.equal(result.status, 0, result.stdout);
	});

	test('checks direction choices against the dimension options', () => {
		const result = apply([
			{ op: 'add', ref: 'm', type: 'dimension', title: 'Where', fields: { options: ['title bar', 'tabs'] } },
			{ op: 'add', type: 'direction', title: 'V', fields: { bet: 'b', breadboard: 'x', choices: { $m: 'sidebar' } } },
		]);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /"sidebar" is not an option of M-1/);
	});
});

describe('confidence', () => {
	const need = (evidence, ref = 'n') => ({ op: 'add', ref, type: 'need', title: `Need ${patches++}`, fields: { when: 'w', want: 'k', so: 's' }, evidence });

	test('needs more independent sources, and user voice, for each level', () => {
		ok('apply', writePatch([
			said('S-1', 'is still running', 'user', 'a'),
			said('S-2', 'no idea which one finished', 'user', 'b'),
			said('S-3', 'cannot tell which agent session', 'support', 'c'),
			said('S-4', 'shows a spinner', 'none', 'd'),
			need(['$a'], 'one'),
			need(['$a', '$b'], 'two'),
			need(['$a', '$b', '$c'], 'three'),
			need(['$c', '$d'], 'novoice'),
		]));
		assert.match(show('N-1'), /confidence: low/);
		assert.match(show('N-2'), /confidence: medium/);
		assert.match(show('N-3'), /confidence: high/);
		assert.match(show('N-4'), /confidence: low/, 'a need with no user voice stays low');
	});

	test('an open contradiction caps an item at medium', () => {
		ok('apply', writePatch([
			said('S-1', 'is still running', 'user', 'a'),
			said('S-2', 'no idea which one finished', 'user', 'b'),
			said('S-3', 'cannot tell which agent session', 'customer', 'c'),
			need(['$a', '$b', '$c']),
			{ op: 'add', ref: 'q', type: 'question', title: 'Do they care?', fields: { kind: 'contradiction', answerer: 'users', domain: 'complex' } },
			{ op: 'link', from: '$q', rel: 'about', to: '$n' },
		]));
		assert.match(show('N-1'), /confidence: medium/);
		ok('apply', writePatch([{ op: 'update', id: 'Q-1', status: 'answered', fields: { answer: 'Yes' } }]));
		assert.match(show('N-1'), /confidence: high/);
	});
});

describe('sources', () => {
	test('parallel writers get distinct source ids', async () => {
		const { spawn } = await import('node:child_process');
		const runs = Array.from({ length: 8 }, (_, i) => {
			const path = join(heap, `extra-${i}.txt`);
			writeFileSync(path, `extra ${i}\n`);
			return new Promise(done => spawn('node', [SCRIPT, 'source', 'add', `https://example.com/${i}`, '--from', path, '--topic', 't'], {
				env: { ...process.env, HSTACK_DESIGN_HOME: home },
			}).on('close', done));
		});
		assert.deepEqual(await Promise.all(runs), Array(8).fill(0));
		const ids = [...ok('pending').matchAll(/^(S-\d+) /gm)].map(match => match[1]);
		assert.equal(new Set(ids).size, 12);
	});
	test('a changed or removed source makes the items that quote it stale', () => {
		ok('apply', writePatch([
			said('S-1', 'is still running', 'user', 'a'),
			said('S-2', 'no idea which one finished', 'user', 'b'),
			{ op: 'add', type: 'audience', title: 'Runner', fields: { situation: 's' }, evidence: ['$a'] },
			{ op: 'add', type: 'audience', title: 'Other', fields: { situation: 's' }, evidence: ['$b'] },
			{ op: 'extracted', src: 'S-1' },
		]));
		assert.equal(ok('list', '--stale'), '');

		writeFileSync(join(heap, 'a.md'), 'Interview A, edited.\n');
		rmSync(join(heap, 'b.md'));
		assert.match(ok('scan', heap), /0 new, 1 changed, 0 restored, 2 unchanged, 1 gone/);
		const stale = ok('list', '--stale');
		assert.match(stale, /A-1 .*stale/);
		assert.match(stale, /A-2 .*stale/);
		assert.match(ok('pending'), /S-1 changed/);
	});
});

test('merge moves evidence and links to the surviving item', () => {
	ok('apply', writePatch([
		said('S-1', 'is still running', 'user', 'a'),
		said('S-2', 'no idea which one finished', 'user', 'b'),
		{ op: 'add', ref: 'aud', type: 'audience', title: 'Runner', fields: { situation: 's' } },
		{ op: 'add', ref: 'x', type: 'need', title: 'Know status', fields: { when: 'w', want: 'k', so: 's' }, evidence: ['$a'] },
		{ op: 'add', ref: 'y', type: 'need', title: 'See finished', fields: { when: 'w', want: 'k', so: 's' }, evidence: ['$b'] },
		{ op: 'link', from: '$y', rel: 'for', to: '$aud' },
		{ op: 'merge', id: '$y', into: '$x' },
	]));
	const merged = show('N-1');
	assert.match(merged, /E-\w+ S-1/);
	assert.match(merged, /E-\w+ S-2/);
	assert.match(merged, /link: N-1 for A-1/);
	assert.match(show('N-2'), /status: merged into N-1/);
});

test('lint flags needs with no audience and directions that are too alike', () => {
	ok('apply', writePatch([
		{ op: 'add', ref: 'n', type: 'need', title: 'Open the status panel', fields: { when: 'w', want: 'open a panel', so: 's' } },
		{ op: 'add', ref: 'm1', type: 'dimension', title: 'Where', fields: { options: ['title bar', 'tabs'] } },
		{ op: 'add', ref: 'm2', type: 'dimension', title: 'Who acts', fields: { options: ['user', 'agent'] } },
		{ op: 'add', ref: 'v1', type: 'direction', title: 'One', fields: { bet: 'b', breadboard: 'x', choices: { $m1: 'title bar', $m2: 'agent' } } },
		{ op: 'add', ref: 'v2', type: 'direction', title: 'Two', fields: { bet: 'b', breadboard: 'x', choices: { $m1: 'tabs', $m2: 'agent' } } },
		{ op: 'link', from: '$v1', rel: 'addresses', to: '$n' },
		{ op: 'link', from: '$v2', rel: 'addresses', to: '$n' },
	]));
	const result = ledger('lint');
	assert.equal(result.status, 1);
	assert.match(result.stdout, /problem: N-1 has no audience/);
	assert.match(result.stdout, /warning: N-1 may describe a solution/);
	assert.match(result.stdout, /problem: V-1 and V-2 differ on 1 dimension/);
});

test('run finish renders views, writes the changelog, and commits', () => {
	ok('apply', writePatch([{ op: 'add', type: 'principle', title: 'Glanceable', fields: { prefer: 'at a glance', over: 'on demand' } }]));
	assert.match(ok('run', 'finish'), /Added: P-1 Glanceable/);
	const dir = join(home, 't');
	assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## R-1/);
	assert.match(readFileSync(join(dir, 'views', 'questions.md'), 'utf8'), /\| P-1 \| Glanceable \|/);
	const log = spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
	assert.match(log.stdout, /R-1/);
	assert.equal(ledger('apply', writePatch([])).status, 1, 'apply needs an open run');
});

function writePatch(ops) {
	const path = join(root, `patch-${patches++}.json`);
	writeFileSync(path, JSON.stringify(ops));
	return path;
}
