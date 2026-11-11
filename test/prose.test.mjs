import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalizeAfterColons, capitalizeMarkdown } from '../scripts/prose.mjs';

const fix = line => capitalizeAfterColons(line).text;

test('capitalizes the word after a colon in prose', () => {
	assert.equal(fix('Cut bloat: speculative layers'), 'Cut bloat: Speculative layers');
	assert.equal(fix('- **retire:** delete it'), '- **retire:** Delete it');
	assert.equal(fix('`quick`: one reviewer'), '`quick`: One reviewer');
});

test('leaves code, refs, URLs, numbers, and tool names alone', () => {
	for (const line of ['See `a: b` here', 'Default: origin/main', 'Docs: https://x.y', 'Exit codes: 0 ok', 'Run: npm test', 'Link [a](b: c)']) {
		assert.equal(fix(line), line);
	}
});

test('touches front matter descriptions only, and skips code fences', () => {
	const input = ['---', 'name: trim', 'description: "Use when: bloat"', '---', '```', 'key: value', '```', 'Then: do it'].join('\n');
	const { text, hits } = capitalizeMarkdown(input);
	assert.equal(text, ['---', 'name: trim', 'description: "Use when: Bloat"', '---', '```', 'key: value', '```', 'Then: Do it'].join('\n'));
	assert.deepEqual(hits.map(h => h.word), ['bloat', 'do']);
});
