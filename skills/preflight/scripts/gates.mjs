// Gate-integrity scan for preflight: Inventory diff hunks that can weaken a check
// (tests, CI, runner and lint config, snapshots) and tag the patterns an agent uses
// to turn a gate green without fixing the code. Tags are facts for a reviewer to read,
// never verdicts. Pattern ids follow gstack's Gate Integrity catalog
// (github.com/garrytan/gstack, MIT; see THIRD_PARTY_NOTICES.md).

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|fixtures?)\/|[._-](test|spec)\.[^/]+$/;
const SNAPSHOT_PATH = /(^|\/)__snapshots__\/|\.(snap|golden)$|(^|\/)testdata\//;
const CI_PATH = /(^|\/)\.github\/workflows\/|(^|\/)azure-pipelines[^/]*\.ya?ml$|(^|\/)build\/azure-pipelines\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\//;
const CONFIG_PATH = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|tsconfig[^/]*\.json|jest\.config\.[^/]+|vitest\.config\.[^/]+|playwright\.config\.[^/]+|\.mocharc[^/]*|karma\.conf[^/]*|\.husky\/[^/]+|lefthook\.ya?ml|\.pre-commit-config\.ya?ml)$/;

const TEST_DECL = /^\s*(test|it|suite|describe|specify)\s*\(/;
const DISABLED_TEST = /\b(test|it|suite|describe|specify)\.(skip|only)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|\.skip\s*\(\s*\)|this\.skip\s*\(/;
const ASSERTION = /\bassert(\.\w+)?\s*\(|\bexpect\s*\(|\.should\b/;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore/;
const BYPASS = /continue-on-error:\s*true|allow_failure:\s*true/;
// Shell-level bypasses only count where commands run: CI, hooks, scripts, and package scripts.
const SHELL_BYPASS = /--no-verify|\|\|\s*true\b|\|\|\s*exit\s+0/;
const SHELL_PATH = /\.(sh|bash|zsh|ps1|ya?ml)$|(^|\/)package\.json$|(^|\/)\.husky\//;
const ENV_SNIFF = /process\.env\.(CI|GITHUB_ACTIONS|TF_BUILD|BUILD_BUILDID|JEST_WORKER_ID|VITEST)\b|NODE_ENV\s*[!=]==?\s*['"]test['"]/;
const PLACEHOLDER = /throw new Error\(\s*['"`](not implemented|todo|unimplemented)/i;
const CATCH_OPEN = /catch\s*(\([^)]*\))?\s*\{\s*$/;
const BLANK_OR_COMMENT = /^\s*(\/\/.*|\/\*.*\*\/\s*)?$/;
const SWALLOW = /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/;
const EXACT_ASSERT = /\b(toBe|toEqual|toStrictEqual|toHaveLength|strictEqual|deepStrictEqual|deepEqual|equal)\s*\(/;
const LOOSE_ASSERT = /\b(toBeGreaterThan(OrEqual)?|toBeLessThan(OrEqual)?|toBeTruthy|toBeDefined|toBeFalsy|toContain|toMatch|assert\.ok|assert\s*\()\s*\(?/;
const LOOSER_IF_UP = /timeout|retr(y|ies)|tolerance|epsilon|delta|maxdiff|jitter|slow|wait/i;
const LOOSER_IF_DOWN = /threshold|min(imum)?[_-]?score|minimum|coverage|required|branches|functions|lines|statements/i;
const SKIP_CI = /\[(skip ci|ci skip|skip actions|actions skip)\]/i;

export const TAGS = {
	'RH-1': 'test removed, skipped, or focused',
	'RH-1?': 'assertions removed',
	'RH-3': 'snapshot changed without its owning test',
	'RH-3?': 'snapshot or golden file changed',
	'RH-4': 'placeholder in product code',
	'RH-12': 'product code branches on the test or CI environment',
	'RH-13': 'checker suppressed',
	'RH-14': 'gate bypassed',
	'RH-15': 'numeric gate relaxed',
	'RH-15?': 'exact assertion loosened',
	'RH-16': 'exception swallowed',
};

export function gateKind(path) {
	if (SNAPSHOT_PATH.test(path)) {
		return 'snapshot';
	}
	if (TEST_PATH.test(path)) {
		return 'test';
	}
	if (CI_PATH.test(path)) {
		return 'ci';
	}
	if (CONFIG_PATH.test(path)) {
		return 'config';
	}
	return undefined;
}

/** Parses `git diff` output into hunks: { path, deleted, start, header, lines: [{ sign, text, line }] }. */
export function parseDiff(text) {
	const hunks = [];
	let path;
	let deleted = false;
	let hunk;
	let newLine = 0;
	for (const raw of text.split('\n')) {
		if (raw.startsWith('diff --git ')) {
			path = undefined;
			deleted = false;
			hunk = undefined;
		} else if (raw.startsWith('--- ') && !hunk) {
			const from = raw.slice(4);
			path = from === '/dev/null' ? path : from.replace(/^a\//, '');
		} else if (raw.startsWith('+++ ') && !hunk) {
			const to = raw.slice(4);
			deleted = to === '/dev/null';
			path = deleted ? path : to.replace(/^b\//, '');
		} else if (raw.startsWith('@@')) {
			const match = /\+(\d+)/.exec(raw);
			newLine = match ? Number(match[1]) : 0;
			hunk = { path, deleted, start: newLine, header: raw, lines: [] };
			hunks.push(hunk);
		} else if (hunk && (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
			const sign = raw[0];
			hunk.lines.push({ sign, text: raw.slice(1), line: sign === '-' ? newLine : newLine++ });
		}
	}
	return hunks;
}

/** A hunk for a file that git does not track yet: every line is added. */
export function addedFileHunk(path, content) {
	const lines = content.replace(/\n$/, '').split('\n');
	return { path, deleted: false, start: 1, header: `@@ -0,0 +1,${lines.length} @@ (untracked)`, lines: lines.map((text, i) => ({ sign: '+', text, line: i + 1 })) };
}

const numbers = text => (text.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
const shape = text => text.replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();

function relaxedNumber(removed, added) {
	const pairs = [];
	for (const old of removed) {
		const twin = added.find(line => shape(line.text) === shape(old.text) && line.text !== old.text);
		if (!twin) {
			continue;
		}
		const [a, b] = [numbers(old.text), numbers(twin.text)];
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			const up = b[i] > a[i];
			if ((up && LOOSER_IF_UP.test(old.text)) || (!up && b[i] < a[i] && LOOSER_IF_DOWN.test(old.text))) {
				pairs.push(twin);
				break;
			}
		}
	}
	return pairs;
}

function tagHunk(hunk, changedPaths) {
	const kind = gateKind(hunk.path);
	const testLike = kind === 'test' || kind === 'snapshot';
	const added = hunk.lines.filter(l => l.sign === '+');
	const removed = hunk.lines.filter(l => l.sign === '-');
	const tags = new Map();
	const tag = (id, line) => {
		if (!tags.has(id)) {
			tags.set(id, line?.line ?? hunk.start);
		}
	};

	if (kind === 'test') {
		// A renamed test removes one declaration and adds another; only a net loss counts.
		const removedDecls = removed.filter(l => TEST_DECL.test(l.text));
		if (removedDecls.length > added.filter(l => TEST_DECL.test(l.text)).length) {
			tag('RH-1', removedDecls[0]);
		}
		added.filter(l => DISABLED_TEST.test(l.text)).forEach(l => tag('RH-1', l));
		const lost = removed.filter(l => ASSERTION.test(l.text)).length - added.filter(l => ASSERTION.test(l.text)).length;
		if (lost > 0) {
			tag('RH-1?', removed.find(l => ASSERTION.test(l.text)));
		}
		const loosened = removed.some(l => EXACT_ASSERT.test(l.text)) && added.find(l => LOOSE_ASSERT.test(l.text) && !EXACT_ASSERT.test(l.text));
		if (loosened) {
			tag('RH-15?', loosened);
		}
	}
	if (kind === 'snapshot') {
		const owner = /^(.*)\/__snapshots__\/(.+)\.snap$/.exec(hunk.path);
		const ownerPath = owner && `${owner[1]}/${owner[2]}`;
		tag(ownerPath && !changedPaths.has(ownerPath) ? 'RH-3' : 'RH-3?');
	}
	if (kind) {
		relaxedNumber(removed, added).forEach(l => tag('RH-15', l));
	}
	added.filter(l => SUPPRESSION.test(l.text)).forEach(l => tag('RH-13', l));
	added.filter(l => BYPASS.test(l.text) || (SHELL_PATH.test(hunk.path) && SHELL_BYPASS.test(l.text))).forEach(l => tag('RH-14', l));
	if (!testLike) {
		added.filter(l => ENV_SNIFF.test(l.text)).forEach(l => tag('RH-12', l));
		added.filter(l => PLACEHOLDER.test(l.text)).forEach(l => tag('RH-4', l));
		added.filter(l => SWALLOW.test(l.text)).forEach(l => tag('RH-16', l));
		const swallowed = emptyCatchBlock(hunk.lines);
		if (swallowed) {
			tag('RH-16', swallowed);
		}
	}
	return { kind, tags };
}

/** An added `catch (e) {` whose next added lines are only blanks or comments before `}`. */
function emptyCatchBlock(lines) {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].sign !== '+' || !CATCH_OPEN.test(lines[i].text)) {
			continue;
		}
		let j = i + 1;
		while (j < lines.length && lines[j].sign === '+' && BLANK_OR_COMMENT.test(lines[j].text)) {
			j++;
		}
		if (j < lines.length && lines[j].sign === '+' && /^\s*\}/.test(lines[j].text)) {
			return lines[i];
		}
	}
	return undefined;
}

/**
 * Returns { tagged: [{ path, line, tags, hunk }], listed: [{ path, line, kind, changed }], commits: [{ sha, subject }] }.
 * `listed` holds untagged hunks in gate paths: inventory to skim, not findings.
 */
export function scanGates(hunks, commitSubjects = []) {
	const changedPaths = new Set(hunks.map(h => h.path));
	const tagged = [];
	const listed = [];
	for (const hunk of hunks) {
		const { kind, tags } = tagHunk(hunk, changedPaths);
		const changed = hunk.lines.filter(l => l.sign !== ' ').length;
		if (tags.size) {
			const line = Math.min(...tags.values());
			tagged.push({ path: hunk.path, line, tags: [...tags.keys()], hunk });
		} else if (kind) {
			listed.push({ path: hunk.path, line: hunk.start, kind, changed });
		}
	}
	const commits = commitSubjects.filter(c => SKIP_CI.test(c.subject));
	return { tagged, listed, commits };
}

export function formatGates({ tagged, listed, commits }, maxLines = 14) {
	const out = [`gate hunks: ${tagged.length} tagged, ${listed.length} listed, ${commits.length} commits skipping CI`];
	if (tagged.length) {
		out.push('', 'Tagged (read each: does this silence the failure it was added for, or is it justified by a measurement or decision visible in this change?)');
	}
	for (const item of tagged) {
		out.push('', `[${item.tags.join(', ')}] ${item.path}:${item.line}  (${item.tags.map(t => TAGS[t]).join('; ')})`);
		out.push(`  ${item.hunk.header}`);
		const body = item.hunk.lines.filter(l => l.sign !== ' ');
		body.slice(0, maxLines).forEach(l => out.push(`  ${l.sign}${l.text}`));
		if (body.length > maxLines) {
			out.push(`  ... ${body.length - maxLines} more changed lines`);
		}
	}
	if (listed.length) {
		const byFile = new Map();
		for (const item of listed) {
			const entry = byFile.get(item.path) ?? { kind: item.kind, line: item.line, hunks: 0, changed: 0 };
			entry.hunks++;
			entry.changed += item.changed;
			byFile.set(item.path, entry);
		}
		out.push('', 'Listed (gate paths with no tag; skim for removed coverage):');
		for (const [path, entry] of byFile) {
			out.push(`  ${entry.kind.padEnd(8)} ${path}:${entry.line} (${entry.hunks} ${entry.hunks === 1 ? 'hunk' : 'hunks'}, ${entry.changed} changed lines)`);
		}
	}
	if (commits.length) {
		out.push('', '[RH-14] commits that skip CI:');
		commits.forEach(c => out.push(`  ${c.sha.slice(0, 10)} ${c.subject}`));
	}
	return out.join('\n');
}
