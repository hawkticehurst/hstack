import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const SCRIPT = fileURLToPath(new URL('../skills/comparison-screenshot/scripts/compose.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'compose-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const image = (name, width, height) => {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#1e1e1e';
	ctx.fillRect(0, 0, width, height);
	const path = join(dir, name);
	writeFileSync(path, canvas.toBuffer('image/png'));
	return path;
};
const compose = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

let beforePng;
let afterPng;
before(() => {
	beforePng = image('before.png', 800, 500);
	afterPng = image('after.png', 800, 500);
});

test('crops both captures identically and lays them out with the standard frame', () => {
	const out = join(dir, 'out', 'comparison.png');
	const result = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before: Start is missing', '--after-label', 'After: Start is shown', '--crop', '100,50,400,200', '--out', out);
	assert.equal(result.status, 0, result.stderr);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.width, 12 + 400 + 16 + 400 + 12);
	assert.equal(summary.height, 38 + 200 + 12);
	assert.ok(Object.values(summary.frame).every(Boolean));
	assert.ok(existsSync(out));
	assert.ok(summary.crops.every(existsSync));
});

test('refuses captures of different sizes', () => {
	const small = image('small.png', 400, 200);
	const result = compose('--before', beforePng, '--after', small, '--before-label', 'Before: a b', '--after-label', 'After: a b', '--out', join(dir, 'x.png'));
	assert.equal(result.status, 2);
	assert.match(result.stderr, /800x500 but After is 400x200/);
});

test('requires labels that start with Before: and After:', () => {
	const result = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before', '--after-label', 'After: a', '--out', join(dir, 'x.png'));
	assert.equal(result.status, 2);
	assert.match(result.stderr, /must start with "Before: "/);
});

test('outlines highlight boxes in red and green inside the cropped images, leaving the frame clean', async () => {
	const { loadImage, createCanvas: canvasFor } = await import('@napi-rs/canvas');
	const out = join(dir, 'boxes.png');
	const result = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before: Header is empty', '--after-label', 'After: Header names it', '--crop', '100,50,400,200', '--before-box', '150,100,100,40', '--after-box', '150,100,100,40', '--out', out);
	assert.equal(result.status, 0, result.stderr);
	assert.ok(Object.values(JSON.parse(result.stdout).frame).every(Boolean));
	const image = await loadImage(out);
	const ctx = canvasFor(image.width, image.height).getContext('2d');
	ctx.drawImage(image, 0, 0);
	const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
	// The box's left edge sits 3.5 px outside it: (150 - 100) - 3.5 in crop space, plus the 12 px frame.
	const y = 38 + (100 - 50) + 20;
	assert.deepEqual(pixel(12 + 50 - 4, y), [220, 38, 38]);
	assert.deepEqual(pixel(12 + 400 + 16 + 50 - 4, y), [22, 163, 74]);
});

test('rejects a highlight box outside the cropped image', () => {
	const result = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before: a b', '--after-label', 'After: a b', '--crop', '100,50,400,200', '--after-box', '0,0,20,20', '--out', join(dir, 'x.png'));
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--after-box 0,0,20,20 falls outside/);
});

test('adds a label tag to the matching box, and rejects more labels than boxes', () => {
	const out = join(dir, 'tags.png');
	const ok = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before: Header is empty', '--after-label', 'After: Header names it', '--crop', '100,50,400,200', '--before-box', '150,100,100,40', '--before-box-label', 'Cloud: empty ()', '--out', out);
	assert.equal(ok.status, 0, ok.stderr);
	const summary = JSON.parse(ok.stdout);
	assert.equal(summary.boxes[0].label, 'Cloud: empty ()');
	assert.ok(Object.values(summary.frame).every(Boolean));
	const extra = compose('--before', beforePng, '--after', afterPng, '--before-label', 'Before: a b', '--after-label', 'After: a b', '--after-box-label', 'orphan', '--out', join(dir, 'x.png'));
	assert.equal(extra.status, 2);
	assert.match(extra.stderr, /--after-box-label was given 1 times but --after-box only 0/);
});
