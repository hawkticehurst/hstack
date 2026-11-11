#!/usr/bin/env node
// compose: Build the standard Before/After comparison image from two authentic captures.
//
//   node compose.mjs --before before.png --after after.png \
//     --before-label "Before: Errored MCP cannot be started" \
//     --after-label "After: Errored MCP shows Start" \
//     --out comparison.png [--crop x,y,width,height] [--font /path/to/Inter-Medium.ttf] \
//     [--before-box x,y,width,height ...] [--after-box x,y,width,height ...] \
//     [--before-box-label text ...] [--after-box-label text ...]
//
// --before-box outlines the area to look at in red, and --after-box in green. Both are
// repeatable and use the same source-pixel coordinates as --crop. Each --*-box-label adds
// a small tag to the box with the same position in the list.
//
// --crop cuts the same rectangle (source pixels) out of both captures and saves the two
// crops next to the output. Without it, both images must already have identical sizes.
// The script enforces the layout constants from SKILL.md, verifies the frame pixels it
// wrote, and prints a JSON summary. Exit codes: 0 written, 2 usage or validation error.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LAYOUT = {
	background: '#f3f3f3',
	backgroundRgb: [243, 243, 243],
	labelColor: '#1f1f1f',
	fontSize: 18,
	fontWeight: 500,
	outerPadding: 12,
	gutter: 16,
	headerHeight: 38,
	labelTop: 8,
	// Highlight colors match rwoll/mono-oss annotate's `problem` and `success` tones.
	beforeBox: '#dc2626',
	afterBox: '#16a34a',
	boxStroke: 3,
	boxGap: 2,
	tagFontSize: 12,
	tagFontWeight: 600,
	tagPadX: 5,
	tagPadY: 3,
	tagText: '#ffffff',
};
const FALLBACK_FAMILIES = ['Inter', 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', 'Arial'];
const FONT_DIRS = [
	join(homedir(), 'Library/Fonts'),
	'/Library/Fonts',
	join(homedir(), '.local/share/fonts'),
	join(homedir(), '.fonts'),
	'/usr/share/fonts',
	'/usr/local/share/fonts',
	process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : '',
	process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft/Windows/Fonts') : '',
].filter(Boolean);

class UsageError extends Error {}

async function loadCanvas() {
	try {
		return await import('@napi-rs/canvas');
	} catch (error) {
		if (error.code !== 'ERR_MODULE_NOT_FOUND') {
			throw error;
		}
		const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
		throw new UsageError(`@napi-rs/canvas is not installed. Run once: npm install --omit=dev --prefix "${root}"`);
	}
}

function findInterFile(dir, depth = 0) {
	if (depth > 3 || !existsSync(dir)) {
		return undefined;
	}
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const fonts = entries.filter(e => e.isFile() && /^Inter.*\.(ttf|otf)$/i.test(e.name)).map(e => e.name);
	const pick = fonts.find(n => /Inter-?Medium\./i.test(n)) ?? fonts.find(n => /Variable|\[/i.test(n) && !/Italic/i.test(n));
	if (pick) {
		return join(dir, pick);
	}
	for (const entry of entries.filter(e => e.isDirectory())) {
		const found = findInterFile(join(dir, entry.name), depth + 1);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function resolveFont(GlobalFonts, explicit) {
	const file = explicit ?? FONT_DIRS.map(dir => findInterFile(dir)).find(Boolean);
	if (file) {
		if (!existsSync(file)) {
			throw new UsageError(`font file not found: ${file}`);
		}
		GlobalFonts.registerFromPath(file, 'hstack-label');
		return { family: 'hstack-label', file };
	}
	const available = new Map(GlobalFonts.families.map(f => [f.family, f.styles]));
	for (const family of FALLBACK_FAMILIES) {
		if (available.get(family)?.some(s => s.weight === LAYOUT.fontWeight && s.style === 'normal')) {
			return { family, file: null };
		}
	}
	return { family: 'sans-serif', file: null };
}

function parseCrop(value, flag = '--crop') {
	const parts = value.split(',').map(Number);
	if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0) || !parts[2] || !parts[3]) {
		throw new UsageError(`${flag} must be x,y,width,height in whole pixels, got "${value}"`);
	}
	const [x, y, width, height] = parts;
	return { x, y, width, height };
}

function labelWarnings(label, prefix) {
	const rest = label.slice(prefix.length).trim().split(/\s+/).slice(1);
	const titled = rest.filter(word => /^[A-Z][a-z]/.test(word));
	return rest.length >= 2 && titled.length >= Math.ceil(rest.length / 2)
		? [`"${label}" looks like Title Case. Text after the colon should be sentence case unless those words are proper nouns.`]
		: [];
}

function cropTo(createCanvas, image, rect, name) {
	if (rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
		throw new UsageError(`--crop ${rect.x},${rect.y},${rect.width},${rect.height} falls outside the ${name} image (${image.width}x${image.height})`);
	}
	const canvas = createCanvas(rect.width, rect.height);
	canvas.getContext('2d').drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
	return canvas;
}

// A filled tag under the outline (above it when there is no room), kept inside the image.
function drawTag(ctx, text, color, outline, image, family) {
	ctx.font = `${LAYOUT.tagFontWeight} ${LAYOUT.tagFontSize}px "${family}"`;
	const metrics = ctx.measureText(text);
	const textHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
	const width = Math.ceil(metrics.width) + 2 * LAYOUT.tagPadX;
	const height = Math.ceil(textHeight) + 2 * LAYOUT.tagPadY;
	if (width > image.width) {
		throw new UsageError(`box label "${text}" is ${width}px wide but the image is ${image.width}px. Shorten it.`);
	}
	const below = outline.y + outline.height;
	const y = below + height <= image.y + image.height ? below : Math.max(image.y, outline.y - height);
	const x = Math.min(Math.max(outline.x, image.x), image.x + image.width - width);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(x, y, width, height, 3);
	ctx.fill();
	ctx.fillStyle = LAYOUT.tagText;
	ctx.textBaseline = 'alphabetic';
	ctx.fillText(text, x + LAYOUT.tagPadX, y + LAYOUT.tagPadY + metrics.fontBoundingBoxAscent);
}

async function main(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			before: { type: 'string' },
			after: { type: 'string' },
			'before-label': { type: 'string' },
			'after-label': { type: 'string' },
			out: { type: 'string' },
			crop: { type: 'string' },
			'before-box': { type: 'string', multiple: true },
			'after-box': { type: 'string', multiple: true },
			'before-box-label': { type: 'string', multiple: true },
			'after-box-label': { type: 'string', multiple: true },
			font: { type: 'string' },
		},
	});
	for (const key of ['before', 'after', 'before-label', 'after-label', 'out']) {
		if (!values[key]) {
			throw new UsageError(`missing --${key}. See the usage at the top of this script.`);
		}
	}
	const labels = { before: values['before-label'].trim(), after: values['after-label'].trim() };
	for (const [side, prefix] of [['before', 'Before: '], ['after', 'After: ']]) {
		if (!labels[side].startsWith(prefix) || labels[side].length <= prefix.length) {
			throw new UsageError(`--${side}-label must start with "${prefix}" and describe the behavior, got "${labels[side]}"`);
		}
	}

	const { createCanvas, loadImage, GlobalFonts } = await loadCanvas();
	for (const side of ['before', 'after']) {
		if (!existsSync(resolve(values[side]))) {
			throw new UsageError(`--${side} image not found: ${values[side]}`);
		}
	}
	const out = resolve(values.out);
	mkdirSync(dirname(out), { recursive: true });
	let before = await loadImage(resolve(values.before));
	let after = await loadImage(resolve(values.after));
	const crops = [];
	if (values.crop) {
		const rect = parseCrop(values.crop);
		before = cropTo(createCanvas, before, rect, 'Before');
		after = cropTo(createCanvas, after, rect, 'After');
		const stem = join(dirname(out), basename(out, extname(out)));
		for (const [side, canvas] of [['before', before], ['after', after]]) {
			const path = `${stem}-${side}-crop.png`;
			writeFileSync(path, await canvas.encode('png'));
			crops.push(path);
		}
	}
	if (before.width !== after.width || before.height !== after.height) {
		throw new UsageError(`Before is ${before.width}x${before.height} but After is ${after.width}x${after.height}. Capture or --crop them to identical bounds; never scale one side.`);
	}

	const { width, height } = before;
	const L = LAYOUT;
	const canvasWidth = L.outerPadding + width + L.gutter + width + L.outerPadding;
	const canvasHeight = L.headerHeight + height + L.outerPadding;
	const beforeX = L.outerPadding;
	const afterX = L.outerPadding + width + L.gutter;

	const font = resolveFont(GlobalFonts, values.font);
	const canvas = createCanvas(canvasWidth, canvasHeight);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = L.background;
	ctx.fillRect(0, 0, canvasWidth, canvasHeight);
	ctx.font = `${L.fontWeight} ${L.fontSize}px "${font.family}"`;
	ctx.fillStyle = L.labelColor;
	ctx.textBaseline = 'alphabetic';
	const warnings = [...labelWarnings(labels.before, 'Before: '), ...labelWarnings(labels.after, 'After: ')];
	for (const [label, x] of [[labels.before, beforeX], [labels.after, afterX]]) {
		const metrics = ctx.measureText(label);
		if (metrics.width > width) {
			throw new UsageError(`"${label}" is ${Math.ceil(metrics.width)}px wide but each image is ${width}px. Shorten the label; do not shrink the font.`);
		}
		// Matches Pillow's default anchor: The top of the font's ascender sits at labelTop.
		ctx.fillText(label, x, L.labelTop + metrics.fontBoundingBoxAscent);
	}
	ctx.drawImage(before, beforeX, L.headerHeight);
	ctx.drawImage(after, afterX, L.headerHeight);

	const origin = values.crop ? parseCrop(values.crop) : { x: 0, y: 0 };
	const boxes = [];
	for (const [side, x, color] of [['before', beforeX, L.beforeBox], ['after', afterX, L.afterBox]]) {
		const tags = values[`${side}-box-label`] ?? [];
		if (tags.length > (values[`${side}-box`] ?? []).length) {
			throw new UsageError(`--${side}-box-label was given ${tags.length} times but --${side}-box only ${(values[`${side}-box`] ?? []).length}. Each label belongs to the box at the same position.`);
		}
		for (const [index, value] of (values[`${side}-box`] ?? []).entries()) {
			const box = parseCrop(value, `--${side}-box`);
			const left = box.x - origin.x;
			const top = box.y - origin.y;
			if (left < 0 || top < 0 || left + box.width > width || top + box.height > height) {
				throw new UsageError(`--${side}-box ${value} falls outside the ${values.crop ? 'cropped ' : ''}${side} image. Use the same source-pixel coordinates as --crop.`);
			}
			// Draw just outside the box so the outline never covers the UI it points at,
			// clipped to the image so the frame stays one solid color.
			const inset = L.boxGap + L.boxStroke / 2;
			ctx.save();
			ctx.beginPath();
			ctx.rect(x, L.headerHeight, width, height);
			ctx.clip();
			ctx.strokeStyle = color;
			ctx.lineWidth = L.boxStroke;
			ctx.beginPath();
			const outline = { x: x + left - inset, y: L.headerHeight + top - inset, width: box.width + 2 * inset, height: box.height + 2 * inset };
			ctx.roundRect(outline.x, outline.y, outline.width, outline.height, 4);
			ctx.stroke();
			const tag = tags[index]?.trim();
			if (tag) {
				drawTag(ctx, tag, color, outline, { x, y: L.headerHeight, width, height }, font.family);
			}
			ctx.restore();
			boxes.push({ side, box: [box.x, box.y, box.width, box.height], color, ...(tag ? { label: tag } : {}) });
		}
	}

	const midY = L.headerHeight + Math.floor(height / 2);
	const probes = {
		topLeft: [0, 0],
		leftFrame: [Math.floor(L.outerPadding / 2), midY],
		gutter: [beforeX + width + Math.floor(L.gutter / 2), midY],
		rightFrame: [canvasWidth - Math.ceil(L.outerPadding / 2), midY],
		bottomFrame: [Math.floor(canvasWidth / 2), canvasHeight - Math.ceil(L.outerPadding / 2)],
	};
	const frame = Object.fromEntries(Object.entries(probes).map(([name, [x, y]]) => {
		const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
		return [name, [r, g, b].every((v, i) => v === L.backgroundRgb[i])];
	}));
	if (!Object.values(frame).every(Boolean)) {
		throw new Error(`frame pixels are not ${L.background}: ${JSON.stringify(frame)}`);
	}

	writeFileSync(out, await canvas.encode('png'));
	if (font.family !== 'hstack-label' && font.family !== 'Inter') {
		warnings.push(`Inter was not found, so labels use ${font.family} ${L.fontWeight}. Pass --font with an Inter Medium file to match the standard exactly.`);
	}
	return { output: out, width: canvasWidth, height: canvasHeight, crop: { width, height }, font: font.file ?? font.family, crops, boxes, frame, warnings };
}

try {
	console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (error) {
	if (error instanceof UsageError || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
		console.error(`compose: ${error.message}`);
		process.exit(2);
	}
	throw error;
}
