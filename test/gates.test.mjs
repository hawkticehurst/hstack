import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedFileHunk, parseDiff, scanGates } from '../skills/preflight/scripts/gates.mjs';

const diff = (path, header, ...lines) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...lines].join('\n');
const tagsFor = (text, commits) => {
	const result = scanGates(parseDiff(text), commits);
	return Object.fromEntries(result.tagged.map(t => [t.path, t.tags]));
};

test('flags skipped, focused, and deleted tests', () => {
	const tags = tagsFor([
		diff('src/a.test.ts', '@@ -10,3 +10,3 @@', "-\ttest('saves', () => {", "+\ttest.skip('saves', () => {", '\t\tassert.ok(x);'),
		diff('src/b.test.ts', '@@ -1,2 +1,2 @@', "-suite('b', () => {", "+suite.only('b', () => {"),
	].join('\n'));
	assert.deepEqual(tags['src/a.test.ts'], ['RH-1']);
	assert.deepEqual(tags['src/b.test.ts'], ['RH-1']);
});

test('flags loosened assertions and raised timeouts but not tightened ones', () => {
	const tags = tagsFor([
		diff('src/c.test.ts', '@@ -5,2 +5,2 @@', '-\tassert.strictEqual(items.length, 3);', '+\tassert.ok(items.length > 0);'),
		diff('src/d.test.ts', '@@ -1,1 +1,1 @@', '-\tthis.timeout(2000);', '+\tthis.timeout(20000);'),
		diff('src/e.test.ts', '@@ -1,1 +1,1 @@', '-\tthis.timeout(20000);', '+\tthis.timeout(2000);'),
	].join('\n'));
	assert.deepEqual(tags['src/c.test.ts'], ['RH-15?']);
	assert.deepEqual(tags['src/d.test.ts'], ['RH-15']);
	assert.equal(tags['src/e.test.ts'], undefined);
});

test('flags suppressions, swallowed errors, and environment sniffing in product code', () => {
	const tags = tagsFor(diff('src/vs/editor/foo.ts', '@@ -1,1 +1,4 @@', ' const a = 1;', '+// @ts-ignore', '+try { run(); } catch { }', "+if (process.env.CI) { return; }"));
	assert.deepEqual(tags['src/vs/editor/foo.ts'].sort(), ['RH-12', 'RH-13', 'RH-16']);
});

test('flags CI bypasses and skip-ci commits', () => {
	const result = scanGates(parseDiff(diff('.github/workflows/ci.yml', '@@ -3,1 +3,2 @@', '   - run: npm test', '+    continue-on-error: true')), [
		{ sha: 'abc1234567', subject: 'Tweak [skip ci]' },
		{ sha: 'def1234567', subject: 'Normal commit' },
	]);
	assert.deepEqual(result.tagged[0].tags, ['RH-14']);
	assert.deepEqual(result.commits.map(c => c.sha), ['abc1234567']);
});

test('tags a snapshot changed without its owning test, and lists untagged gate hunks', () => {
	const result = scanGates([
		...parseDiff(diff('src/__snapshots__/view.test.ts.snap', '@@ -1,1 +1,1 @@', '-old', '+new')),
		...parseDiff(diff('src/other.test.ts', '@@ -1,1 +1,2 @@', ' a', '+\tassert.equal(b, 2);')),
	]);
	assert.deepEqual(result.tagged.map(t => [t.path, t.tags]), [['src/__snapshots__/view.test.ts.snap', ['RH-3']]]);
	assert.deepEqual(result.listed.map(l => l.path), ['src/other.test.ts']);
});

test('ignores ordinary product changes and new tests', () => {
	const result = scanGates([
		...parseDiff(diff('src/vs/base/common/x.ts', '@@ -1,1 +1,2 @@', ' a', '+const b = compute(a);')),
		addedFileHunk('src/x.test.ts', "suite('x', () => {\n\ttest('y', () => assert.equal(1, 1));\n});\n"),
	]);
	assert.equal(result.tagged.length, 0);
	assert.deepEqual(result.listed.map(l => l.path), ['src/x.test.ts']);
});

test('ignores renamed tests and shell-looking text in TypeScript', () => {
	const result = scanGates(parseDiff([
		diff('src/f.test.ts', '@@ -1,1 +1,1 @@', "-\ttest('old name', () => {", "+\ttest('new name', () => {"),
		diff('src/g.ts', '@@ -1,1 +1,2 @@', ' a', "+const enabled = configured || true;", "+const hint = 'commit with --no-verify to skip hooks';"),
	].join('\n')));
	assert.equal(result.tagged.length, 0);
});

test('flags shell bypasses in scripts and a multi-line empty catch', () => {
	const tags = tagsFor([
		diff('build/lint.sh', '@@ -1,1 +1,1 @@', '-npm run lint', '+npm run lint || true'),
		diff('src/h.ts', '@@ -1,1 +1,5 @@', ' a', '+try {', '+\trun();', '+} catch (e) {', '+\t// ignore', '+}'),
	].join('\n'));
	assert.deepEqual(tags['build/lint.sh'], ['RH-14']);
	assert.deepEqual(tags['src/h.ts'], ['RH-16']);
});
