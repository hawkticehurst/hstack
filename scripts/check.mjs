#!/usr/bin/env node
// Validate hstack: Skill frontmatter, relative links and anchors, bundled script syntax,
// the harness manifests, and the prose rule that the word after a colon is capitalized.
//
//   node scripts/check.mjs          report problems
//   node scripts/check.mjs --fix    also capitalize words after colons in place
//
// Exits 1 and lists every problem when anything is wrong.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capitalizeMarkdown } from './prose.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
const LINK = /\]\(([^)\s]+)\)/g;
const FENCE = /^\s*(```|~~~)/;
const problems = [];
const rel = path => relative(ROOT, path);

function frontmatter(text) {
	const lines = text.split('\n');
	if (lines[0] !== '---') {
		return undefined;
	}
	const fields = {};
	for (const line of lines.slice(1)) {
		if (line === '---') {
			return fields;
		}
		const match = /^([\w-]+):\s*(.*)$/.exec(line);
		if (match) {
			fields[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
		}
	}
	return undefined;
}

const slug = heading => heading.trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\w\s-]/g, '').replace(/\s/g, '-');

function headings(path) {
	const found = new Set();
	let inFence = false;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (FENCE.test(line)) {
			inFence = !inFence;
		} else if (!inFence && line.startsWith('#')) {
			found.add(slug(line.replace(/^#+/, '')));
		}
	}
	return found;
}

function checkLinks(path) {
	let inFence = false;
	readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
		if (FENCE.test(line)) {
			inFence = !inFence;
			return;
		}
		if (inFence) {
			return;
		}
		for (const [, target] of line.matchAll(LINK)) {
			if (/^[a-z]+:/.test(target) || target.startsWith('<')) {
				continue;
			}
			const [file, anchor] = target.split('#');
			const dest = file ? resolve(dirname(path), file) : path;
			const where = `${rel(path)}:${index + 1}`;
			if (!existsSync(dest)) {
				problems.push(`${where}: broken link ${target}`);
			} else if (anchor && dest.endsWith('.md') && !headings(dest).has(anchor)) {
				problems.push(`${where}: missing anchor #${anchor} in ${file || 'this file'}`);
			}
		}
	});
}

function walk(dir, predicate, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === '.git' || name === 'node_modules') {
			continue;
		}
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			walk(path, predicate, out);
		} else if (predicate(path)) {
			out.push(path);
		}
	}
	return out;
}

const skillDirs = readdirSync(SKILLS).map(name => join(SKILLS, name)).filter(path => statSync(path).isDirectory());
for (const dir of skillDirs) {
	const skill = join(dir, 'SKILL.md');
	if (!existsSync(skill)) {
		problems.push(`${rel(dir)}: missing SKILL.md`);
		continue;
	}
	const fields = frontmatter(readFileSync(skill, 'utf8'));
	if (!fields) {
		problems.push(`${rel(skill)}: missing or unterminated frontmatter`);
		continue;
	}
	const name = basename(dir);
	if (fields.name !== name) {
		problems.push(`${rel(skill)}: name '${fields.name}' does not match folder '${name}'`);
	}
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
		problems.push(`${rel(skill)}: name must be lowercase words joined by hyphens, at most 64 characters`);
	}
	if (!fields.description) {
		problems.push(`${rel(skill)}: missing description`);
	} else if (fields.description.length > 1024) {
		problems.push(`${rel(skill)}: description is ${fields.description.length} characters; the limit is 1024`);
	}
	// Codex ignores disable-model-invocation, so manual-only skills also need its policy file.
	const manualOnly = fields['disable-model-invocation'] === 'true';
	const policy = join(dir, 'agents', 'openai.yaml');
	const codexManual = existsSync(policy) && /allow_implicit_invocation:\s*false/.test(readFileSync(policy, 'utf8'));
	if (manualOnly !== codexManual) {
		problems.push(manualOnly
			? `${rel(skill)}: disable-model-invocation is true, so add agents/openai.yaml with policy.allow_implicit_invocation: false`
			: `${rel(policy)}: blocks implicit invocation in Codex, but SKILL.md does not set disable-model-invocation: true`);
	}
}

try {
	const marketplace = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
	const plugin = marketplace.plugins?.find(p => p.name === 'hstack');
	if (!marketplace.name || !marketplace.owner?.name) {
		problems.push('.claude-plugin/marketplace.json: name and owner.name are required');
	}
	if (!plugin || plugin.source !== './') {
		problems.push('.claude-plugin/marketplace.json: needs a plugin named hstack with source "./"');
	} else if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) {
		problems.push('.claude-plugin/marketplace.json: the hstack plugin needs a semver version');
	}
} catch (error) {
	problems.push(`.claude-plugin/marketplace.json: ${error.message}`);
}
for (const stray of ['plugin.json', '.claude-plugin/plugin.json']) {
	if (existsSync(join(ROOT, stray))) {
		problems.push(`${stray}: remove it; .claude-plugin/marketplace.json is the only manifest`);
	}
}

const fix = process.argv.includes('--fix');
for (const md of walk(ROOT, path => path.endsWith('.md'))) {
	checkLinks(md);
	const { text, hits } = capitalizeMarkdown(readFileSync(md, 'utf8'));
	if (fix && hits.length) {
		writeFileSync(md, text);
		console.log(`${rel(md)}: capitalized ${hits.length} words after colons`);
	} else {
		hits.forEach(hit => problems.push(`${rel(md)}:${hit.line}: capitalize "${hit.word}" after the colon (run with --fix)`));
	}
}

for (const script of walk(ROOT, path => path.endsWith('.mjs') && !path.startsWith(join(ROOT, 'node_modules')))) {
	const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
	if (result.status !== 0) {
		problems.push(`${rel(script)}: ${result.stderr.trim().split('\n').slice(0, 4).join(' ')}`);
	}
}

for (const problem of problems) {
	console.log(problem);
}
console.log(`${problems.length ? 'FAIL' : 'ok'}: ${skillDirs.length} skills, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
