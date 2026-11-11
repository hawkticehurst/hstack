#!/usr/bin/env node
// preflight-state: git facts and review records for the preflight review loop.
//
//   preflight-state base                 merge base the review compares against
//   preflight-state size                 diff size, prod vs tests, files that cross or grow past 1000 lines
//   preflight-state snapshot             tree id of the working tree, untracked files included
//   preflight-state delta <tree>         diff from a snapshot to the current working tree
//   preflight-state gates                test, CI, and config hunks, tagged where a gate may have been weakened
//   preflight-state save --verdict ready|fix|rethink [--mode M] [--rounds N] [--findings FILE]
//   preflight-state check                exit 0 only when a ready review matches the current change
//   preflight-state stats [--days N]     per-reviewer outcomes from this repository's review history
//
// Every command accepts --base <ref> (default: origin/HEAD, then origin/main, origin/master, main, master).
//
// The change is everything between the merge base and the working tree: Committed,
// staged, unstaged, and untracked files. Its fingerprint hashes each changed path's
// mode and contents on both the base side and the working-tree side. Committing, or
// rebasing onto a base that did not touch those files, keeps a review fresh. Any edit,
// mode change, or upstream change to those files makes it stale.
//
// The latest review lives at `git rev-parse --git-path hstack/preflight.json` (one per
// worktree). Finding outcomes are appended to hstack/preflight-history.jsonl in the
// common git directory, shared by every worktree of the repository.
//
// Exit codes: 0 success (check: Fresh and ready), 1 check failed, 2 usage or git error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { addedFileHunk, formatGates, parseDiff, scanGates } from './gates.mjs';

const LARGE_FILE_LINES = 1000;
// Files already over the limit are reported only when they grow by at least this much.
const LARGE_FILE_GROWTH = 50;
const VERDICTS = ['ready', 'fix', 'rethink'];
const OUTCOMES = ['fixed', 'open', 'declined', 'rejected'];
const SEVERITIES = ['blocker', 'should', 'nit'];
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|fixtures?)\/|[._-](test|spec)\.[^/]+$/;

class Failure extends Error {
	constructor(message, code = 2) {
		super(message);
		this.code = code;
	}
}

function run(args, { env, input, ok = [0], raw = false } = {}) {
	const proc = spawnSync('git', args, { env, input, maxBuffer: 512 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' });
	if (proc.error) {
		throw new Failure(`cannot run git: ${proc.error.message}`);
	}
	if (!ok.includes(proc.status)) {
		const stderr = raw ? proc.stderr.toString() : proc.stderr;
		throw new Failure(`git ${args.slice(0, 3).join(' ')} failed: ${stderr.trim()}`);
	}
	return proc;
}

const git = (args, options) => run(args, options).stdout;
const zsplit = text => text.split('\0').filter(Boolean);

function defaultBaseRef() {
	const originHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { ok: [0, 1] }).trim();
	if (originHead) {
		return originHead;
	}
	for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
		if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { ok: [0, 1] }).trim()) {
			return ref;
		}
	}
	throw new Failure('no base ref found. Pass --base <ref>.');
}

const mergeBase = ref => git(['merge-base', 'HEAD', ref]).trim();

function changedPaths(base) {
	const tracked = zsplit(git(['diff', '--no-renames', '--name-only', '-z', base]));
	const untracked = new Set(zsplit(git(['ls-files', '--others', '--exclude-standard', '-z'])));
	return { paths: [...new Set([...tracked, ...untracked])].sort(), untracked };
}

function stat(path) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function worktreeMode(info) {
	if (info.isSymbolicLink()) {
		return '120000';
	}
	return info.mode & 0o100 ? '100755' : '100644';
}

function fingerprint(base) {
	const { paths } = changedPaths(base);
	const before = new Map();
	if (paths.length) {
		for (const entry of zsplit(git(['ls-tree', '-z', base, '--', ...paths]))) {
			const [meta, path] = entry.split('\t');
			const [mode, , blob] = meta.split(' ');
			before.set(path, `${mode} ${blob}`);
		}
	}
	const present = paths.filter(path => {
		const info = stat(path);
		return info && !info.isDirectory() && !info.isSymbolicLink();
	});
	const hashes = present.length ? git(['hash-object', '--stdin-paths'], { input: present.join('\n') + '\n' }).split(/\s+/).filter(Boolean) : [];
	const after = new Map(present.map((path, i) => [path, `${worktreeMode(stat(path))} ${hashes[i]}`]));
	// A symlink's content is its target text, hashed the way git stores it.
	for (const path of paths.filter(path => stat(path)?.isSymbolicLink())) {
		const target = Buffer.from(readlinkSync(path));
		const blob = createHash('sha1').update(`blob ${target.length}\0`).update(target).digest('hex');
		after.set(path, `120000 ${blob}`);
	}
	const digest = createHash('sha256');
	for (const path of paths) {
		digest.update(`${path}\0${before.get(path) ?? 'absent'}\0${after.get(path) ?? 'deleted'}\n`);
	}
	return digest.digest('hex').slice(0, 16);
}

function lineCount(buffer) {
	if (buffer.includes(0)) {
		return undefined;
	}
	let lines = 0;
	for (const byte of buffer) {
		if (byte === 10) {
			lines++;
		}
	}
	return buffer.length && buffer[buffer.length - 1] !== 10 ? lines + 1 : lines;
}

function baseLines(base, path) {
	const proc = run(['cat-file', '-p', `${base}:${path}`], { ok: [0, 128], raw: true });
	return proc.status === 0 ? lineCount(proc.stdout) : 0;
}

function size(baseRef) {
	const base = mergeBase(baseRef);
	const { paths, untracked } = changedPaths(base);
	const totals = { prod: [0, 0], tests: [0, 0] };
	const kind = path => (TEST_PATH.test(path) ? 'tests' : 'prod');
	for (const line of git(['diff', '--no-renames', '--numstat', base]).split('\n').filter(Boolean)) {
		const [added, removed, path] = line.split('\t');
		if (added !== '-') {
			totals[kind(path)][0] += Number(added);
			totals[kind(path)][1] += Number(removed);
		}
	}
	for (const path of [...untracked].sort()) {
		const info = stat(path);
		const lines = info?.isFile() ? lineCount(readFileSync(path)) : undefined;
		if (lines) {
			totals[kind(path)][0] += lines;
		}
	}

	const large = [];
	for (const path of paths) {
		if (!stat(path)?.isFile()) {
			continue;
		}
		const now = lineCount(readFileSync(path));
		const before = baseLines(base, path);
		if (now === undefined || before === undefined || now <= LARGE_FILE_LINES || now <= before) {
			continue;
		}
		if (before > LARGE_FILE_LINES && now - before < LARGE_FILE_GROWTH) {
			continue;
		}
		const note = before <= LARGE_FILE_LINES ? `crossed ${LARGE_FILE_LINES}` : `+${now - before}, already over ${LARGE_FILE_LINES}`;
		large.push(`  ${path}: ${before} -> ${now} lines (${note})`);
	}

	const added = totals.prod[0] + totals.tests[0];
	const removed = totals.prod[1] + totals.tests[1];
	const heading = `large files (crossed ${LARGE_FILE_LINES} lines, or grew ${LARGE_FILE_GROWTH}+ past it)`;
	return [
		`base: ${baseRef} @ ${base.slice(0, 10)}`,
		`files: ${paths.length} changed (${untracked.size} untracked)`,
		`diff: +${added} -${removed} (prod +${totals.prod[0]} -${totals.prod[1]}, tests +${totals.tests[0]} -${totals.tests[1]})`,
		large.length ? `${heading}:` : `${heading}: none`,
		...large,
	].join('\n');
}

// Writes the working tree, untracked files included, as a tree object without touching the real index.
function snapshot() {
	const realIndex = git(['rev-parse', '--git-path', 'index']).trim();
	const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
	try {
		const index = join(dir, 'index');
		if (existsSync(realIndex)) {
			copyFileSync(realIndex, index);
		}
		const env = { ...process.env, GIT_INDEX_FILE: index };
		git(['add', '--all'], { env });
		return git(['write-tree'], { env }).trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function gates(baseRef) {
	const base = mergeBase(baseRef);
	const hunks = parseDiff(git(['diff', '--no-renames', '-U3', base]));
	for (const path of changedPaths(base).untracked) {
		const info = stat(path);
		if (info?.isFile() && info.size < 1024 * 1024) {
			const content = readFileSync(path);
			if (lineCount(content) !== undefined) {
				hunks.push(addedFileHunk(path, content.toString('utf8')));
			}
		}
	}
	const commits = git(['log', '--format=%H%x09%s', `${base}..HEAD`]).split('\n').filter(Boolean).map(line => {
		const [sha, ...subject] = line.split('\t');
		return { sha, subject: subject.join('\t') };
	});
	return formatGates(scanGates(hunks, commits));
}

const statePath = () => resolve(git(['rev-parse', '--git-path', 'hstack/preflight.json']).trim());
const historyPath = () => join(resolve(git(['rev-parse', '--git-common-dir']).trim()), 'hstack', 'preflight-history.jsonl');

function loadFindings(path) {
	if (!path) {
		return [];
	}
	let findings;
	try {
		findings = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Failure(`cannot read findings from ${path}: ${error.message}`);
	}
	if (!Array.isArray(findings)) {
		throw new Failure('findings must be a JSON array');
	}
	for (const item of findings) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Failure('each finding must be a JSON object');
		}
		const missing = ['id', 'reviewer', 'severity', 'outcome'].filter(key => !item[key]);
		if (missing.length) {
			throw new Failure(`finding ${item.id ?? '?'} is missing ${missing.join(', ')}`);
		}
		if (!SEVERITIES.includes(item.severity)) {
			throw new Failure(`finding ${item.id}: severity must be one of ${SEVERITIES.join(', ')}`);
		}
		if (!OUTCOMES.includes(item.outcome)) {
			throw new Failure(`finding ${item.id}: outcome must be one of ${OUTCOMES.join(', ')}`);
		}
	}
	return findings;
}

function save(baseRef, options) {
	if (!VERDICTS.includes(options.verdict)) {
		throw new Failure(`--verdict must be one of ${VERDICTS.join(', ')}`);
	}
	const findings = loadFindings(options.findings);
	const open = findings.filter(f => f.outcome === 'open' && f.severity !== 'nit').map(f => f.id);
	if (options.verdict === 'ready' && open.length) {
		throw new Failure(`verdict cannot be ready while blocker or should findings are open: ${open.join(', ')}`);
	}
	const base = mergeBase(baseRef);
	const time = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
	const record = {
		version: 1,
		fingerprint: fingerprint(base),
		base_ref: baseRef,
		base,
		head: git(['rev-parse', 'HEAD']).trim(),
		verdict: options.verdict,
		mode: options.mode ?? 'standard',
		rounds: Number(options.rounds ?? 1),
		open,
		time,
	};
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(record, null, 2) + '\n');

	if (findings.length) {
		const branch = git(['branch', '--show-current']).trim();
		const history = historyPath();
		mkdirSync(dirname(history), { recursive: true });
		const rows = findings.map(item => {
			const { id, reviewer, severity, outcome, title = null, reason = null } = item;
			return JSON.stringify({ time, branch, head: record.head, id, reviewer, severity, outcome, title, reason });
		});
		appendFileSync(history, rows.join('\n') + '\n');
	}
	return `saved ${record.verdict} review of ${record.fingerprint} (${findings.length} findings) to ${path}`;
}

function check(baseRef) {
	const path = statePath();
	if (!existsSync(path)) {
		throw new Failure('no preflight review recorded for this worktree', 1);
	}
	let record;
	try {
		record = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new Failure(`unreadable review record at ${path}`, 1);
	}
	if (record.fingerprint !== fingerprint(mergeBase(baseRef))) {
		throw new Failure(`stale: the change differs from the ${record.verdict} review of ${record.time}`, 1);
	}
	if (record.verdict !== 'ready') {
		throw new Failure(`latest review verdict is ${record.verdict}, not ready (open: ${record.open?.join(', ') || 'none'})`, 1);
	}
	return `fresh ready review from ${record.time} (${record.mode}, ${record.rounds} rounds)`;
}

function stats(days) {
	const history = historyPath();
	if (!existsSync(history)) {
		return 'no review history yet';
	}
	const since = days ? Date.now() - Number(days) * 86_400_000 : undefined;
	const counts = new Map();
	for (const line of readFileSync(history, 'utf8').split('\n')) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (since && !(Date.parse(row.time) >= since)) {
			continue;
		}
		for (const name of String(row.reviewer || 'unknown').split(',')) {
			const reviewer = name.trim();
			const outcomes = counts.get(reviewer) ?? {};
			outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
			counts.set(reviewer, outcomes);
		}
	}
	if (!counts.size) {
		return 'no findings in range';
	}
	const total = outcomes => Object.values(outcomes).reduce((a, b) => a + b, 0);
	const lines = [`${'reviewer'.padEnd(16)} ${'total'.padStart(5)} ${'fixed'.padStart(6)} ${'open'.padStart(5)} ${'declined'.padStart(8)} ${'rejected'.padStart(8)} ${'valid'.padStart(6)}`];
	for (const [reviewer, outcomes] of [...counts].sort((a, b) => total(b[1]) - total(a[1]))) {
		const n = total(outcomes);
		const valid = Math.floor((100 * (n - (outcomes.rejected ?? 0))) / n);
		const cell = (key, width) => String(outcomes[key] ?? 0).padStart(width);
		lines.push(`${reviewer.padEnd(16)} ${String(n).padStart(5)} ${cell('fixed', 6)} ${cell('open', 5)} ${cell('declined', 8)} ${cell('rejected', 8)} ${`${valid}%`.padStart(6)}`);
	}
	return lines.join('\n');
}

const COMMANDS = ['base', 'size', 'gates', 'snapshot', 'delta', 'save', 'check', 'stats'];

function main(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			base: { type: 'string' },
			verdict: { type: 'string' },
			mode: { type: 'string' },
			rounds: { type: 'string' },
			findings: { type: 'string' },
			days: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
	});
	const [command, arg] = positionals;
	if (values.help || !COMMANDS.includes(command)) {
		throw new Failure(`usage: preflight-state <${COMMANDS.join('|')}> [--base <ref>] (see the header of this script)`);
	}
	const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
	if (top.status !== 0) {
		throw new Failure('not inside a git work tree');
	}
	process.chdir(top.stdout.trim());
	const baseRef = () => values.base || defaultBaseRef();

	switch (command) {
		case 'base': return `${baseRef()} ${mergeBase(baseRef())}`;
		case 'size': return size(baseRef());
		case 'gates': return gates(baseRef());
		case 'snapshot': return snapshot();
		case 'delta':
			if (!arg) {
				throw new Failure('usage: preflight-state delta <tree>');
			}
			process.stdout.write(git(['diff', '--no-renames', arg, snapshot()]));
			return undefined;
		case 'save': return save(baseRef(), values);
		case 'check': return check(baseRef());
		case 'stats': return stats(values.days);
	}
}

try {
	const output = main(process.argv.slice(2));
	if (output !== undefined) {
		console.log(output);
	}
} catch (error) {
	if (error instanceof Failure || error.code?.startsWith?.('ERR_PARSE_ARGS')) {
		console.error(`preflight-state: ${error.message}`);
		process.exit(error instanceof Failure ? error.code : 2);
	}
	throw error;
}
