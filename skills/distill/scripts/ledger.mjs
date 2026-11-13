#!/usr/bin/env node
// The evidence ledger behind the distill and shape skills.
//
// Each topic is a folder under $HSTACK_DESIGN_HOME (default ~/.hstack/design). The JSONL files
// in ledger/ are append-only, and the latest record for an id wins, so the files are the full
// history. snapshots/ keeps the exact text of every source version, so every quote can be
// checked against what the source said when it was quoted. views/, README.md, and
// CHANGELOG.md are generated. Run with no arguments for usage.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: ledger.mjs <command> --topic <slug> [options]

Topics
  topics                                  list topics
  init                                    create the topic folder and frame.md
Runs
  run start [--note <text>]               open a run (or report the open one)
  run finish                              render views, write CHANGELOG.md, commit
Sources
  scan <dir> [--kind <k>] [--group <g>]   add or refresh every text file under <dir>
  source add <uri> [--from <file>|-] [--kind <k>] [--title <t>] [--group <g>] [--date <d>]
  source gone <S-id>                      mark a source as removed
  pending                                 sources not yet extracted at their current version
Changes
  apply <patch.json> [--drop-invalid] [--dry-run]
Reading
  list [--type <t>] [--status <s>] [--stale] [--run <R-id>]
  show <id>...
  evidence [--run <R-id>] [--src <S-id>] [--uncited]
  sample [--count <n>] [--run <R-id>]
  lint
  render`;

const HOME = resolve(process.env.HSTACK_DESIGN_HOME || join(homedir(), '.hstack', 'design'));
const TEMPLATE = fileURLToPath(new URL('../references/frame.md', import.meta.url));
const BOOLEAN = new Set(['drop-invalid', 'dry-run', 'stale', 'uncited']);
const READ_ONLY = new Set(['pending', 'list', 'show', 'evidence', 'sample', 'lint']);

export const SOURCE_KINDS = ['doc', 'issue', 'pr', 'chat', 'meeting', 'research', 'data', 'code', 'design', 'web', 'note', 'other'];
export const EVIDENCE_KINDS = ['said', 'did', 'measured', 'built', 'decided', 'inferred'];
export const SPEAKERS = ['user', 'customer', 'designer', 'pm', 'engineer', 'leadership', 'support', 'researcher', 'unknown', 'none'];
const USER_VOICE = new Set(['user', 'customer']);
const BASE_STATUSES = ['proposed', 'confirmed'];
const LIST_FIELDS = new Set(['outcomes', 'avoid', 'attributes', 'actions', 'states', 'options', 'rabbit_holes', 'no_gos']);

// graded: confidence comes from evidence. voice: high confidence needs people's own words or behavior.
export const TYPES = {
	need: { prefix: 'N', required: ['when', 'want', 'so'], optional: ['today', 'outcomes'], graded: true, voice: true },
	audience: { prefix: 'A', required: ['situation'], optional: ['expects'], graded: true, voice: true },
	term: { prefix: 'T', required: ['definition'], optional: ['avoid', 'code', 'ui', 'docs', 'users'], graded: true },
	object: { prefix: 'O', required: ['definition'], optional: ['attributes', 'actions', 'states'], graded: true },
	concept: { prefix: 'C', required: ['purpose', 'principle'], optional: ['state', 'actions'], graded: true },
	constraint: {
		prefix: 'K', required: ['kind', 'strength'], optional: ['detail'], graded: true,
		enums: { kind: ['technical', 'platform', 'business', 'policy', 'accessibility', 'time', 'other'], strength: ['hard', 'soft'] },
	},
	assumption: {
		prefix: 'H', required: ['risk', 'importance'], optional: ['test'], graded: true,
		enums: { risk: ['desirability', 'usability', 'feasibility', 'viability'], importance: ['high', 'medium', 'low'] },
	},
	principle: { prefix: 'P', required: ['prefer', 'over'], optional: ['why'] },
	question: {
		prefix: 'Q', required: ['kind', 'answerer', 'domain'], optional: ['answer'], statuses: ['answered'],
		enums: { kind: ['open', 'contradiction', 'gap'], answerer: ['agent', 'designer', 'users', 'stakeholder'], domain: ['clear', 'complicated', 'complex'] },
	},
	decision: { prefix: 'D', required: ['choice', 'provenance', 'rejected', 'reason'], enums: { provenance: ['user-directed', 'user-approved'] } },
	dimension: { prefix: 'M', required: ['options'], optional: ['why'] },
	direction: {
		prefix: 'V', required: ['bet', 'choices', 'breadboard'], optional: ['rabbit_holes', 'no_gos', 'premortem', 'fit', 'brief'],
		statuses: ['shortlisted', 'chosen', 'rejected'],
	},
};
const TYPE_BY_PREFIX = Object.fromEntries(Object.entries(TYPES).map(([type, spec]) => [spec.prefix, type]));

// Allowed links: [from types, to types]; '*' means any item type.
export const RELS = {
	for: [['need'], ['audience']],
	has: [['object'], ['object']],
	uses: [['concept', 'direction'], ['object', 'concept']],
	addresses: [['direction'], ['need']],
	about: [['question', 'assumption', 'decision', 'constraint', 'principle'], ['*']],
	'depends-on': [['question', 'direction'], ['question', 'assumption']],
	conflicts: [['*'], ['*']],
};

class UserError extends Error {}
const fail = message => {
	throw new UserError(message);
};

// ---------- storage ----------

const hash = text => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
const linkKey = link => `${link.from} ${link.rel} ${link.to}`;
export const normalize = text => String(text)
	.replace(/[\u2018\u2019]/g, '\'')
	.replace(/[\u201c\u201d]/g, '"')
	.replace(/\s+/g, ' ')
	.trim();

function readJsonl(path) {
	if (!existsSync(path)) {
		return [];
	}
	// Drop the last segment: It is empty, or a line another process is still writing.
	const lines = readFileSync(path, 'utf8').split('\n');
	lines.pop();
	return lines.filter(Boolean).map((line, index) => {
		try {
			return JSON.parse(line);
		} catch {
			return fail(`${path}:${index + 1}: not valid JSON`);
		}
	});
}

function latest(records, key = record => record.id) {
	const map = new Map();
	for (const record of records) {
		map.set(key(record), record);
	}
	return map;
}

export function load(dir) {
	const file = name => join(dir, 'ledger', `${name}.jsonl`);
	const raw = Object.fromEntries(['runs', 'sources', 'evidence', 'items', 'links'].map(name => [name, readJsonl(file(name))]));
	return {
		dir,
		raw,
		runs: latest(raw.runs),
		sources: latest(raw.sources),
		evidence: latest(raw.evidence),
		items: latest(raw.items),
		links: latest(raw.links, linkKey),
		texts: new Map(),
	};
}

function append(state, name, record) {
	appendFileSync(join(state.dir, 'ledger', `${name}.jsonl`), `${JSON.stringify(record)}\n`);
	state.raw[name].push(record);
}

function topicDir(flags, { create = false } = {}) {
	const topic = flags.topic;
	if (!topic || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(topic)) {
		fail('pass --topic <slug>, lowercase words joined by hyphens');
	}
	const dir = join(HOME, topic);
	if (!create && !existsSync(join(dir, 'ledger'))) {
		fail(`no topic "${topic}" in ${HOME}; run init first`);
	}
	return dir;
}

function nextId(map, prefix) {
	let max = 0;
	for (const id of map.keys()) {
		const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
		if (match) {
			max = Math.max(max, Number(match[1]));
		}
	}
	return `${prefix}-${max + 1}`;
}

const openRun = state => [...state.runs.values()].find(run => !run.finished);
function requireRun(state) {
	return openRun(state)?.id ?? fail('no open run; run `run start` first');
}

const snapshotPath = (dir, source) => join(dir, 'snapshots', source.id, `${source.fp}.txt`);
function sourceText(state, id, fp) {
	const key = `${id}@${fp}`;
	if (!state.texts.has(key)) {
		const path = join(state.dir, 'snapshots', id, `${fp}.txt`);
		state.texts.set(key, existsSync(path) ? normalize(readFileSync(path, 'utf8')) : undefined);
	}
	return state.texts.get(key);
}

// ---------- derived facts ----------

const active = item => item && item.status !== 'merged' && item.status !== 'retired';
const activeItems = state => [...state.items.values()].filter(active);
const activeLinks = state => [...state.links.values()].filter(link => !link.removed);
const liveEvidence = (state, item) => (item.evidence ?? []).map(id => state.evidence.get(id)).filter(ev => ev && !ev.retracted);

export function isStale(state, ev) {
	const source = state.sources.get(ev.src);
	return !source || source.status !== 'active' || source.fp !== ev.fp;
}

// The confidence rubric. It is computed, never asserted, so it means the same thing on every run.
export function grade(state, item) {
	if (!TYPES[item.type]?.graded) {
		return undefined;
	}
	const evidence = liveEvidence(state, item);
	if (!evidence.length) {
		return 'unsupported';
	}
	const groupOf = ev => state.sources.get(ev.src)?.group || ev.src;
	const direct = evidence.filter(ev => ev.kind !== 'inferred');
	const groups = new Set(direct.map(groupOf));
	const voiceGroups = new Set(direct.filter(ev => USER_VOICE.has(ev.speaker) || ev.kind === 'did' || ev.kind === 'measured').map(groupOf));
	if (groups.size < 2 || (TYPES[item.type].voice && voiceGroups.size === 0)) {
		return 'low';
	}
	const contested = activeLinks(state).some(link => {
		const question = state.items.get(link.from);
		return link.rel === 'about' && link.to === item.id && active(question) && question.fields.kind === 'contradiction' && question.status !== 'answered';
	});
	if (contested || groups.size < 3 || (TYPES[item.type].voice && voiceGroups.size < 2)) {
		return 'medium';
	}
	return 'high';
}

export const itemStale = (state, item) => liveEvidence(state, item).some(ev => isStale(state, ev));

// ---------- validation ----------

function checkEnum(name, value, allowed) {
	if (!allowed.includes(value)) {
		fail(`${name} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
	}
	return value;
}

function checkFields(state, type, fields, resolveId) {
	const spec = TYPES[type];
	const known = new Set([...spec.required, ...(spec.optional ?? []), 'note']);
	const out = {};
	for (const [key, value] of Object.entries(fields ?? {})) {
		if (!known.has(key)) {
			fail(`${type} has no field "${key}"; fields: ${[...known].join(', ')}`);
		}
		if (value === null || value === undefined) {
			continue;
		}
		if (LIST_FIELDS.has(key)) {
			if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.trim())) {
				fail(`${key} must be a list of non-empty strings`);
			}
			out[key] = value;
		} else if (key === 'choices' || key === 'fit') {
			if (typeof value !== 'object' || Array.isArray(value)) {
				fail(`${key} must be an object`);
			}
			out[key] = {};
			for (const [rawId, choice] of Object.entries(value)) {
				const id = resolveId(rawId);
				const target = state.items.get(id);
				const wanted = key === 'choices' ? 'dimension' : 'principle';
				if (!active(target) || target.type !== wanted) {
					fail(`${key} key ${rawId} is not an active ${wanted}`);
				}
				if (typeof choice !== 'string' || !choice.trim()) {
					fail(`${key}.${rawId} must be a non-empty string`);
				}
				if (key === 'choices' && !target.fields.options.includes(choice)) {
					fail(`"${choice}" is not an option of ${id}; options: ${target.fields.options.join(' | ')}`);
				}
				out[key][id] = choice;
			}
		} else if (typeof value !== 'string' || !value.trim()) {
			fail(`${key} must be a non-empty string`);
		} else {
			out[key] = spec.enums?.[key] ? checkEnum(key, value, spec.enums[key]) : value;
		}
	}
	for (const key of spec.required) {
		if (out[key] === undefined || (Array.isArray(out[key]) && !out[key].length)) {
			fail(`${type} needs "${key}"`);
		}
	}
	if (type === 'dimension' && out.options.length < 2) {
		fail('a dimension needs at least two options');
	}
	return out;
}

function checkStatus(type, status) {
	return checkEnum('status', status, [...BASE_STATUSES, ...(TYPES[type].statuses ?? [])]);
}

function checkEvidenceIds(state, ids, resolveId) {
	if (!Array.isArray(ids)) {
		fail('evidence must be a list of E- ids');
	}
	return ids.map(raw => {
		const id = resolveId(raw);
		const ev = state.evidence.get(id);
		if (!ev || ev.retracted) {
			fail(`unknown or retracted evidence ${raw}`);
		}
		return id;
	});
}

function activeItem(state, raw, resolveId) {
	const id = resolveId(raw);
	const item = state.items.get(id);
	if (!active(item)) {
		fail(`${raw} is not an active item`);
	}
	return item;
}

const nonEmpty = (name, value) => (typeof value === 'string' && value.trim() ? value.trim() : fail(`${name} must be a non-empty string`));

// Validates one op against the current state. Returns [file, record] pairs and mutates state
// only after the op is fully valid, so a rejected op leaves no trace.
function applyOp(state, op, resolveId, refs) {
	const setRef = id => {
		if (op.ref !== undefined) {
			if (refs.has(op.ref)) {
				fail(`ref "${op.ref}" is used twice`);
			}
			refs.set(op.ref, id);
		}
	};
	switch (op?.op) {
		case 'evidence': {
			const source = state.sources.get(op.src);
			if (!source || source.status !== 'active') {
				fail(`unknown or gone source ${op.src}`);
			}
			const quote = normalize(nonEmpty('quote', op.quote));
			if (quote.length < 4 || quote.length > 300) {
				fail(`quote must be 4 to 300 characters; it is ${quote.length}`);
			}
			if (!sourceText(state, source.id, source.fp)?.includes(quote)) {
				fail(`quote is not verbatim in ${op.src}: "${quote.slice(0, 80)}"`);
			}
			const about = op.about ?? [];
			if (!Array.isArray(about) || about.some(tag => typeof tag !== 'string')) {
				fail('about must be a list of strings');
			}
			const id = `E-${hash(`${source.id}\n${quote}`).slice(0, 8)}`;
			setRef(id);
			if (state.evidence.get(id) && !state.evidence.get(id).retracted) {
				return [];
			}
			const record = {
				id, src: source.id, fp: source.fp, loc: op.loc ? String(op.loc) : undefined, quote,
				kind: checkEnum('kind', op.kind, EVIDENCE_KINDS), speaker: checkEnum('speaker', op.speaker ?? 'unknown', SPEAKERS),
				about, note: op.note, date: op.date,
			};
			state.evidence.set(id, record);
			return [['evidence', record]];
		}
		case 'extracted': {
			const source = state.sources.get(op.src) ?? fail(`unknown source ${op.src}`);
			const record = { ...source, extracted: source.fp };
			state.sources.set(source.id, record);
			return [['sources', record]];
		}
		case 'retract': {
			const ev = state.evidence.get(op.id);
			if (!ev || ev.retracted) {
				fail(`unknown or already retracted evidence ${op.id}`);
			}
			const record = { ...ev, retracted: true, reason: nonEmpty('reason', op.reason) };
			state.evidence.set(ev.id, record);
			return [['evidence', record]];
		}
		case 'add': {
			if (!TYPES[op.type]) {
				fail(`unknown type ${op.type}; types: ${Object.keys(TYPES).join(', ')}`);
			}
			const record = {
				type: op.type,
				title: nonEmpty('title', op.title),
				status: checkStatus(op.type, op.status ?? 'proposed'),
				fields: checkFields(state, op.type, op.fields, resolveId),
				evidence: checkEvidenceIds(state, op.evidence ?? [], resolveId),
			};
			const id = nextId(state.items, TYPES[op.type].prefix);
			setRef(id);
			state.items.set(id, { id, ...record });
			return [['items', state.items.get(id)]];
		}
		case 'update': {
			const item = activeItem(state, op.id, resolveId);
			const fields = { ...item.fields };
			for (const [key, value] of Object.entries(op.fields ?? {})) {
				if (value === null) {
					delete fields[key];
				} else {
					fields[key] = value;
				}
			}
			const evidence = new Set(item.evidence);
			checkEvidenceIds(state, op.add_evidence ?? [], resolveId).forEach(id => evidence.add(id));
			(op.remove_evidence ?? []).forEach(raw => evidence.delete(resolveId(raw)));
			const record = {
				...item,
				title: op.title === undefined ? item.title : nonEmpty('title', op.title),
				status: op.status === undefined ? item.status : checkStatus(item.type, op.status),
				fields: checkFields(state, item.type, fields, resolveId),
				evidence: [...evidence],
			};
			if (op.reason) {
				record.reason = op.reason;
			}
			state.items.set(item.id, record);
			return [['items', record]];
		}
		case 'link':
		case 'unlink': {
			const from = activeItem(state, op.from, resolveId);
			const to = activeItem(state, op.to, resolveId);
			const allowed = RELS[op.rel] ?? fail(`unknown rel ${op.rel}; rels: ${Object.keys(RELS).join(', ')}`);
			const fits = (types, type) => types.includes('*') || types.includes(type);
			if (!fits(allowed[0], from.type) || !fits(allowed[1], to.type)) {
				fail(`${op.rel} links ${allowed[0].join('|')} to ${allowed[1].join('|')}, not ${from.type} to ${to.type}`);
			}
			if (from.id === to.id) {
				fail('an item cannot link to itself');
			}
			const existing = state.links.get(linkKey({ from: from.id, rel: op.rel, to: to.id }));
			const isLinked = existing && !existing.removed;
			if (op.op === 'link' ? isLinked && existing.label === op.label : !isLinked) {
				return [];
			}
			const record = op.op === 'link'
				? { from: from.id, rel: op.rel, to: to.id, label: op.label }
				: { from: from.id, rel: op.rel, to: to.id, removed: true };
			state.links.set(linkKey(record), record);
			return [['links', record]];
		}
		case 'merge': {
			const item = activeItem(state, op.id, resolveId);
			const into = activeItem(state, op.into, resolveId);
			if (item.id === into.id || item.type !== into.type) {
				fail('merge needs two different items of the same type');
			}
			const out = [];
			const merged = { ...item, status: 'merged', merged_into: into.id, reason: op.reason };
			const target = { ...into, evidence: [...new Set([...into.evidence, ...item.evidence])] };
			state.items.set(item.id, merged);
			state.items.set(into.id, target);
			out.push(['items', merged], ['items', target]);
			for (const link of activeLinks(state).filter(link => link.from === item.id || link.to === item.id)) {
				const removed = { ...link, removed: true };
				state.links.set(linkKey(link), removed);
				out.push(['links', removed]);
				const moved = { ...link, from: link.from === item.id ? into.id : link.from, to: link.to === item.id ? into.id : link.to };
				const already = state.links.get(linkKey(moved));
				if (moved.from !== moved.to && (!already || already.removed)) {
					state.links.set(linkKey(moved), moved);
					out.push(['links', moved]);
				}
			}
			return out;
		}
		case 'retire': {
			const item = activeItem(state, op.id, resolveId);
			const record = { ...item, status: 'retired', reason: nonEmpty('reason', op.reason) };
			state.items.set(item.id, record);
			return [['items', record]];
		}
		default:
			return fail(`unknown op ${JSON.stringify(op?.op)}; ops: evidence, extracted, retract, add, update, link, unlink, merge, retire`);
	}
}

export function applyPatch(state, patch, { dropInvalid = false, dryRun = false } = {}) {
	const ops = Array.isArray(patch) ? patch : patch?.ops;
	if (!Array.isArray(ops)) {
		fail('a patch is a JSON array of ops, or an object with an "ops" array');
	}
	const run = requireRun(state);
	const refs = new Map();
	const resolveId = raw => {
		if (typeof raw !== 'string') {
			return fail(`expected an id, got ${JSON.stringify(raw)}`);
		}
		return raw.startsWith('$') ? refs.get(raw.slice(1)) ?? fail(`unknown ref ${raw}`) : raw;
	};
	const writes = [];
	const errors = [];
	ops.forEach((op, index) => {
		try {
			writes.push(...applyOp(state, op, resolveId, refs));
		} catch (error) {
			if (!(error instanceof UserError)) {
				throw error;
			}
			errors.push(`op ${index + 1} (${op?.op ?? '?'}${op?.ref ? ` ${op.ref}` : ''}): ${error.message}`);
		}
	});
	const ok = !errors.length || dropInvalid;
	if (ok && !dryRun) {
		const at = now();
		for (const [file, record] of writes) {
			append(state, file, { ...record, run, at });
		}
	}
	return { ok, errors, writes: writes.length, refs: Object.fromEntries(refs) };
}

// ---------- sources ----------

function readTextFile(path) {
	const buffer = readFileSync(path);
	return buffer.subarray(0, 8000).includes(0) ? undefined : buffer.toString('utf8');
}

export function addSource(state, { uri, text, kind, title, group, date }) {
	const run = requireRun(state);
	if (kind !== undefined) {
		checkEnum('kind', kind, SOURCE_KINDS);
	}
	const existing = [...state.sources.values()].find(source => source.uri === uri);
	const fp = hash(text).slice(0, 16);
	if (existing && existing.fp === fp && existing.status === 'active') {
		return { status: 'unchanged', source: existing };
	}
	const id = existing?.id ?? nextId(state.sources, 'S');
	const record = {
		...existing,
		id,
		uri,
		kind: kind ?? existing?.kind ?? 'other',
		title: title ?? existing?.title ?? basename(uri),
		group: group ?? existing?.group,
		date: date ?? existing?.date,
		fp,
		chars: text.length,
		status: 'active',
	};
	const path = snapshotPath(state.dir, record);
	mkdirSync(join(state.dir, 'snapshots', id), { recursive: true });
	writeFileSync(path, text);
	const stored = { ...record, run, at: now() };
	append(state, 'sources', stored);
	state.sources.set(id, stored);
	return { status: !existing ? 'new' : existing.fp === fp ? 'restored' : 'changed', source: stored };
}

function markGone(state, source) {
	const record = { ...source, status: 'gone', run: requireRun(state), at: now() };
	append(state, 'sources', record);
	state.sources.set(source.id, record);
}

function walkFiles(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name.startsWith('.') || name === 'node_modules') {
			continue;
		}
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			walkFiles(path, out);
		} else if (stat.isFile()) {
			out.push({ path, size: stat.size });
		}
	}
	return out;
}

export function scan(state, dir, { kind, group } = {}) {
	const root = resolve(dir);
	const counts = { new: 0, changed: 0, restored: 0, unchanged: 0, gone: 0, skipped: 0 };
	const seen = new Set();
	const skipped = [];
	for (const { path, size } of walkFiles(root)) {
		const text = size <= 2_000_000 ? readTextFile(path) : undefined;
		if (text === undefined || !text.trim()) {
			counts.skipped++;
			skipped.push(path);
			continue;
		}
		const { status } = addSource(state, { uri: path, text, kind, group });
		counts[status]++;
		seen.add(path);
	}
	for (const source of [...state.sources.values()]) {
		if (source.status === 'active' && source.uri.startsWith(root + sep) && !seen.has(source.uri)) {
			markGone(state, source);
			counts.gone++;
		}
	}
	return { counts, skipped };
}

const pendingSources = state => [...state.sources.values()].filter(source => source.status === 'active' && source.extracted !== source.fp);

// ---------- views ----------

const cell = value => String(value ?? '').replace(/</g, '&lt;').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nodeId = id => id.replace('-', '_');
const nodeLabel = text => `"${String(text).replace(/"/g, '#quot;').replace(/[<>[\]{}]/g, ' ').slice(0, 70)}"`;
const table = (headers, rows) => rows.length
	? [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
	: '_None yet._';
const byType = (state, type) => activeItems(state).filter(item => item.type === type);
const linksOf = (state, rel) => activeLinks(state).filter(link => link.rel === rel);
const confidenceTag = (state, item) => [grade(state, item), itemStale(state, item) ? 'stale' : undefined].filter(Boolean).join(', ');

function frameTitle(state, topic) {
	const path = join(state.dir, 'frame.md');
	const line = existsSync(path) ? readFileSync(path, 'utf8').split('\n').find(text => text.startsWith('# ')) : undefined;
	const title = line?.slice(2).trim();
	return title && !title.startsWith('<') ? title : topic;
}

function needsView(state) {
	const needs = byType(state, 'need');
	const audiences = byType(state, 'audience');
	const forLinks = linksOf(state, 'for');
	const lines = ['# Needs and audiences', '', 'Generated by the ledger. Job stories: When <situation>, I want to <motivation>, so I can <outcome>.', ''];
	if (needs.length || audiences.length) {
		lines.push('```mermaid', 'flowchart LR');
		audiences.forEach(a => lines.push(`  ${nodeId(a.id)}([${nodeLabel(`${a.id} ${a.title}`)}])`));
		needs.forEach(n => lines.push(`  ${nodeId(n.id)}[${nodeLabel(`${n.id} ${n.title}`)}]:::${grade(state, n)}`));
		forLinks.forEach(link => lines.push(`  ${nodeId(link.to)} --> ${nodeId(link.from)}`));
		lines.push('  classDef high stroke-width:3px', '  classDef medium stroke-width:2px', '  classDef low stroke-dasharray:4 3', '  classDef unsupported stroke-dasharray:1 3', '```', '');
	}
	lines.push('## Audiences', '', table(['Id', 'Audience', 'Situation', 'Confidence', 'Status'],
		audiences.map(a => [a.id, a.title, a.fields.situation, confidenceTag(state, a), a.status])), '');
	const groups = [...audiences.map(a => [a, needs.filter(n => forLinks.some(l => l.from === n.id && l.to === a.id))]),
		[undefined, needs.filter(n => !forLinks.some(l => l.from === n.id))]];
	for (const [audience, list] of groups) {
		if (!list.length) {
			continue;
		}
		lines.push(`## ${audience ? `${audience.id} ${audience.title}` : 'Needs with no audience yet'}`, '');
		lines.push(table(['Id', 'Need', 'Job story', 'Today', 'Confidence', 'Evidence', 'Status'], list.map(n => [
			n.id, n.title, `When ${n.fields.when}, I want to ${n.fields.want}, so I can ${n.fields.so}.`, n.fields.today ?? '',
			confidenceTag(state, n), liveEvidence(state, n).length, n.status,
		])), '');
	}
	return lines.join('\n');
}

function modelView(state) {
	const terms = byType(state, 'term');
	const objects = byType(state, 'object');
	const concepts = byType(state, 'concept');
	const constraints = byType(state, 'constraint');
	const lines = ['# Model', '', 'Generated by the ledger. The glossary columns compare the words used in code, UI, docs, and by users; a mismatch is a design problem.', ''];
	lines.push('## Glossary', '', table(['Id', 'Term', 'Definition', 'Avoid', 'Code', 'UI', 'Docs', 'Users', 'Confidence'], terms.map(t => [
		t.id, t.title, t.fields.definition, (t.fields.avoid ?? []).join(', '), t.fields.code, t.fields.ui, t.fields.docs, t.fields.users, confidenceTag(state, t),
	])), '');
	lines.push('## Objects', '');
	const has = linksOf(state, 'has');
	const uses = linksOf(state, 'uses').filter(link => state.items.get(link.from)?.type === 'concept');
	if (objects.length) {
		lines.push('```mermaid', 'flowchart LR');
		objects.forEach(o => lines.push(`  ${nodeId(o.id)}[${nodeLabel(`${o.id} ${o.title}`)}]`));
		concepts.forEach(c => lines.push(`  ${nodeId(c.id)}((${nodeLabel(`${c.id} ${c.title}`)}))`));
		has.forEach(link => lines.push(`  ${nodeId(link.from)} -->${link.label ? `|${nodeLabel(link.label)}|` : ''} ${nodeId(link.to)}`));
		uses.forEach(link => lines.push(`  ${nodeId(link.from)} -.-> ${nodeId(link.to)}`));
		lines.push('```', '');
	}
	lines.push(table(['Id', 'Object', 'Definition', 'Attributes', 'Actions', 'States', 'Confidence'], objects.map(o => [
		o.id, o.title, o.fields.definition, (o.fields.attributes ?? []).join(', '), (o.fields.actions ?? []).join(', '), (o.fields.states ?? []).join(', '), confidenceTag(state, o),
	])), '');
	lines.push('## Concepts', '', 'One purpose each. A concept with two purposes is overloaded; two concepts with one purpose are redundant.', '');
	lines.push(table(['Id', 'Concept', 'Purpose', 'Operating principle', 'Actions', 'Confidence'], concepts.map(c => [
		c.id, c.title, c.fields.purpose, c.fields.principle, (c.fields.actions ?? []).join(', '), confidenceTag(state, c),
	])), '');
	lines.push('## Constraints', '', table(['Id', 'Constraint', 'Kind', 'Strength', 'Detail', 'Confidence'], constraints.map(k => [
		k.id, k.title, k.fields.kind, k.fields.strength, k.fields.detail, confidenceTag(state, k),
	])), '');
	return lines.join('\n');
}

function questionsView(state) {
	const questions = byType(state, 'question');
	const assumptions = byType(state, 'assumption');
	const lines = ['# Questions, assumptions, principles, and decisions', '', 'Generated by the ledger.', '', '## Open questions', ''];
	const open = questions.filter(q => q.status !== 'answered');
	for (const answerer of TYPES.question.enums.answerer) {
		const list = open.filter(q => q.fields.answerer === answerer);
		if (list.length) {
			lines.push(`### For ${answerer === 'users' ? 'research with real users' : `the ${answerer}`}`, '');
			lines.push(table(['Id', 'Question', 'Kind', 'Domain', 'About'], list.map(q => [
				q.id, q.title, q.fields.kind, q.fields.domain,
				activeLinks(state).filter(link => link.from === q.id && link.rel === 'about').map(link => link.to).join(', '),
			])), '');
		}
	}
	if (!open.length) {
		lines.push('_None open._', '');
	}
	lines.push('## Assumptions', '');
	if (assumptions.length) {
		const x = { unsupported: 0.1, low: 0.35, medium: 0.6, high: 0.85 };
		const y = { low: 0.2, medium: 0.5, high: 0.8 };
		lines.push('```mermaid', 'quadrantChart', '  title Test the top-left first', '  x-axis Weak evidence --> Strong evidence', '  y-axis Less important --> More important',
			'  quadrant-1 Known and important', '  quadrant-2 Test first', '  quadrant-3 Watch', '  quadrant-4 Known, less important');
		assumptions.forEach((h, index) => {
			const jitter = (index % 5) * 0.025;
			lines.push(`  ${h.id.replace('-', '')}: [${(x[grade(state, h)] + jitter).toFixed(3)}, ${(y[h.fields.importance] + jitter).toFixed(3)}]`);
		});
		lines.push('```', '');
	}
	lines.push(table(['Id', 'Assumption', 'Risk', 'Importance', 'Evidence', 'How to test'], assumptions.map(h => [
		h.id, h.title, h.fields.risk, h.fields.importance, confidenceTag(state, h), h.fields.test,
	])), '');
	lines.push('## Principles', '', table(['Id', 'Principle', 'Prefer', 'Over', 'Why', 'Status'], byType(state, 'principle').map(p => [
		p.id, p.title, p.fields.prefer, p.fields.over, p.fields.why, p.status,
	])), '');
	lines.push('## Decisions', '', table(['Id', 'Decision', 'Choice', 'Rejected', 'Reason', 'Provenance'], byType(state, 'decision').map(d => [
		d.id, d.title, d.fields.choice, d.fields.rejected, d.fields.reason, d.fields.provenance,
	])), '');
	const answered = questions.filter(q => q.status === 'answered');
	if (answered.length) {
		lines.push('## Answered questions', '', table(['Id', 'Question', 'Answer'], answered.map(q => [q.id, q.title, q.fields.answer])), '');
	}
	return lines.join('\n');
}

function directionsView(state) {
	const dimensions = byType(state, 'dimension');
	const directions = byType(state, 'direction');
	const lines = ['# Design space and directions', '', 'Generated by the ledger.', '', '## Design space', ''];
	lines.push(table(['Dimension', 'Options', ...directions.map(v => `${v.id} ${v.title}`)], dimensions.map(m => [
		`${m.id} ${m.title}`, m.fields.options.join(' / '), ...directions.map(v => v.fields.choices[m.id] ?? '-'),
	])), '');
	const addresses = linksOf(state, 'addresses');
	if (directions.length) {
		lines.push('```mermaid', 'flowchart LR');
		directions.forEach(v => lines.push(`  ${nodeId(v.id)}[${nodeLabel(`${v.id} ${v.title}`)}]`));
		[...new Set(addresses.map(link => link.to))].forEach(id => lines.push(`  ${nodeId(id)}([${nodeLabel(`${id} ${state.items.get(id).title}`)}])`));
		addresses.forEach(link => lines.push(`  ${nodeId(link.from)} --> ${nodeId(link.to)}`));
		lines.push('```', '');
	}
	for (const v of directions) {
		lines.push(`## ${v.id} ${v.title} (${v.status})`, '', `**Bet:** ${v.fields.bet}`, '');
		lines.push(`**Addresses:** ${addresses.filter(link => link.from === v.id).map(link => `${link.to} ${state.items.get(link.to).title}`).join('; ') || 'none yet'}`, '');
		if (v.fields.fit) {
			lines.push(table(['Principle', 'Fit'], Object.entries(v.fields.fit).map(([id, fit]) => [`${id} ${state.items.get(id)?.title ?? ''}`, fit])), '');
		}
		lines.push('**Breadboard**', '', '```text', v.fields.breadboard, '```', '');
		for (const [key, label] of [['rabbit_holes', 'Rabbit holes'], ['no_gos', 'No-gos']]) {
			if (v.fields[key]?.length) {
				lines.push(`**${label}**`, '', ...v.fields[key].map(entry => `- ${entry}`), '');
			}
		}
		if (v.fields.premortem) {
			lines.push(`**Premortem:** ${v.fields.premortem}`, '');
		}
		if (v.fields.brief) {
			lines.push(`**Prototype brief:** [${v.fields.brief}](../${v.fields.brief})`, '');
		}
	}
	return lines.join('\n');
}

function sourcesView(state) {
	const cited = new Set(activeItems(state).flatMap(item => item.evidence ?? []));
	const evidence = [...state.evidence.values()].filter(ev => !ev.retracted);
	return ['# Sources', '', 'Generated by the ledger. Quotes are checked against the snapshot taken when they were extracted.', '',
		table(['Id', 'Kind', 'Title', 'Status', 'Extracted', 'Nuggets', 'Cited', 'Location'], [...state.sources.values()].map(s => {
			const own = evidence.filter(ev => ev.src === s.id);
			return [s.id, s.kind, s.title, s.status, s.extracted === s.fp ? 'yes' : 'no', own.length, own.filter(ev => cited.has(ev.id)).length, s.uri];
		})), ''].join('\n');
}

export function render(state, topic) {
	mkdirSync(join(state.dir, 'views'), { recursive: true });
	const views = { 'needs.md': needsView(state), 'model.md': modelView(state), 'questions.md': questionsView(state), 'sources.md': sourcesView(state) };
	if (byType(state, 'dimension').length || byType(state, 'direction').length) {
		views['directions.md'] = directionsView(state);
	}
	for (const [name, text] of Object.entries(views)) {
		writeFileSync(join(state.dir, 'views', name), text);
	}
	const items = activeItems(state);
	const count = type => items.filter(item => item.type === type).length;
	const needs = byType(state, 'need');
	const grades = ['high', 'medium', 'low', 'unsupported'].map(g => `${needs.filter(n => grade(state, n) === g).length} ${g}`).join(', ');
	const stale = items.filter(item => itemStale(state, item));
	const open = byType(state, 'question').filter(q => q.status !== 'answered');
	const runs = [...state.runs.values()];
	const last = runs.at(-1);
	const readme = [
		`# ${frameTitle(state, topic)}`, '',
		'Managed by the hstack distill and shape skills. Edit `frame.md` and `briefs/` by hand. Everything else is written by the ledger script: `ledger/` is the append-only record, and `views/`, this file, and `CHANGELOG.md` are generated.', '',
		`Last run: ${last ? `${last.id}${last.note ? ` (${last.note})` : ''}, ${last.finished ? `finished ${last.finished.slice(0, 10)}` : 'still open'}` : 'none'}`, '',
		'## At a glance', '',
		`- ${plural(count('need'), 'need')} (${grades}), ${['audience', 'term', 'object', 'concept', 'constraint'].map(type => plural(count(type), type)).join(', ')}`,
		`- ${['principle', 'assumption', 'decision'].map(type => plural(count(type), type)).join(', ')}, ${plural(open.length, 'open question')}`,
		`- ${plural([...state.sources.values()].filter(s => s.status === 'active').length, 'source')}, ${plural([...state.evidence.values()].filter(ev => !ev.retracted).length, 'evidence quote')}, ${pendingSources(state).length} waiting for extraction`,
		...(count('direction') ? [`- ${plural(count('dimension'), 'design dimension')}, ${plural(count('direction'), 'direction')}`] : []),
		...(stale.length ? [`- Stale (a source changed since it was quoted): ${stale.map(item => item.id).join(', ')}`] : []),
		'', '## Open questions', '',
		...(open.length ? open.slice(0, 12).map(q => `- ${q.id} (${q.fields.answerer}, ${q.fields.domain}): ${q.title}`) : ['None.']),
		...(open.length > 12 ? [`- ...and ${open.length - 12} more in [views/questions.md](views/questions.md)`] : []),
		'', '## Views', '',
		'- [Frame](frame.md)', '- [Needs and audiences](views/needs.md)', '- [Model: Glossary, objects, concepts, constraints](views/model.md)',
		'- [Questions, assumptions, principles, decisions](views/questions.md)',
		...(views['directions.md'] ? ['- [Design space and directions](views/directions.md)'] : []),
		'- [Sources](views/sources.md)', '- [Changelog](CHANGELOG.md)', '',
	].join('\n');
	writeFileSync(join(state.dir, 'README.md'), readme);
	return Object.keys(views);
}

// ---------- reports ----------

function changelogEntry(state, run) {
	const inRun = list => list.filter(record => record.run === run.id);
	const firstRun = new Map();
	for (const record of state.raw.items) {
		if (!firstRun.has(record.id)) {
			firstRun.set(record.id, record.run);
		}
	}
	const itemRecords = inRun(state.raw.items);
	const ids = [...new Set(itemRecords.map(record => record.id))];
	const label = id => `${id} ${state.items.get(id).title}`;
	const finalStatus = id => state.items.get(id).status;
	const added = ids.filter(id => firstRun.get(id) === run.id && active(state.items.get(id)));
	const merged = ids.filter(id => finalStatus(id) === 'merged');
	const retired = ids.filter(id => finalStatus(id) === 'retired');
	const updated = ids.filter(id => !added.includes(id) && !merged.includes(id) && !retired.includes(id) && firstRun.get(id) !== run.id);
	const sourceRecords = inRun(state.raw.sources);
	const changed = new Set(sourceRecords.filter(s => s.status === 'active' && s.extracted !== s.fp).map(s => s.id));
	const gone = new Set(sourceRecords.filter(s => s.status === 'gone').map(s => s.id));
	const evidence = inRun(state.raw.evidence);
	const lines = [`## ${run.id}: ${run.started.slice(0, 10)}${run.note ? `, ${run.note}` : ''}`, ''];
	lines.push(`- Sources: ${changed.size} new or changed, ${gone.size} gone`);
	lines.push(`- Evidence: ${evidence.filter(ev => !ev.retracted).length} added, ${evidence.filter(ev => ev.retracted).length} retracted`);
	if (added.length) {
		lines.push(`- Added: ${added.map(label).join('; ')}`);
	}
	if (updated.length) {
		lines.push(`- Updated: ${updated.map(label).join('; ')}`);
	}
	if (merged.length) {
		lines.push(`- Merged: ${merged.map(id => `${id} into ${state.items.get(id).merged_into}`).join('; ')}`);
	}
	if (retired.length) {
		lines.push(`- Retired: ${retired.map(id => `${label(id)} (${state.items.get(id).reason})`).join('; ')}`);
	}
	const stale = activeItems(state).filter(item => itemStale(state, item));
	if (stale.length) {
		lines.push(`- Stale: ${stale.map(item => item.id).join(', ')}`);
	}
	return lines.join('\n');
}

function git(dir, ...args) {
	return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function describeItem(state, item) {
	const lines = [`${item.id} ${item.type}: ${item.title}`, `  status: ${item.status}${item.merged_into ? ` into ${item.merged_into}` : ''}${item.reason ? ` (${item.reason})` : ''}`];
	const tag = confidenceTag(state, item);
	if (tag) {
		lines.push(`  confidence: ${tag}`);
	}
	for (const [key, value] of Object.entries(item.fields)) {
		lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
	}
	for (const ev of liveEvidence(state, item)) {
		lines.push(`  ${ev.id} ${ev.src}${ev.loc ? ` ${ev.loc}` : ''} (${ev.kind}, ${ev.speaker}${isStale(state, ev) ? ', stale' : ''}): "${ev.quote}"`);
	}
	for (const link of activeLinks(state).filter(l => l.from === item.id || l.to === item.id)) {
		lines.push(`  link: ${link.from} ${link.rel} ${link.to}${link.label ? ` (${link.label})` : ''}`);
	}
	return lines.join('\n');
}

const summary = (state, item) => {
	const tag = [item.status, confidenceTag(state, item)].filter(Boolean).join(', ');
	return `${item.id} [${tag}] ${item.title}${TYPES[item.type].graded ? ` (${liveEvidence(state, item).length} ev)` : ''}`;
};

export function lint(state) {
	const problems = [];
	const warnings = [];
	const items = activeItems(state);
	const links = activeLinks(state);
	for (const link of links) {
		if (!active(state.items.get(link.from)) || !active(state.items.get(link.to))) {
			problems.push(`link ${link.from} ${link.rel} ${link.to} points at an inactive item`);
		}
	}
	for (const item of items) {
		if (item.type === 'need' && !links.some(l => l.rel === 'for' && l.from === item.id)) {
			problems.push(`${item.id} has no audience; link it "for" an audience`);
		}
		if (item.type === 'need' && /\b(button|menu|dialog|modal|panel|tab|sidebar|toggle|dropdown|page|screen|view|setting|notification|wizard)s?\b/i.test(`${item.fields.want} ${item.title}`)) {
			warnings.push(`${item.id} may describe a solution, not a need; ask whether there is more than one way to meet it`);
		}
		if (item.type === 'question' && item.status === 'answered' && !item.fields.answer) {
			problems.push(`${item.id} is answered but has no answer`);
		}
		if (item.type === 'direction' && !links.some(l => l.rel === 'addresses' && l.from === item.id)) {
			problems.push(`${item.id} addresses no need; link it to the needs it serves`);
		}
		if (TYPES[item.type].graded && grade(state, item) === 'unsupported') {
			warnings.push(`${item.id} has no evidence`);
		}
		if (itemStale(state, item)) {
			warnings.push(`${item.id} is stale: a source it quotes changed or is gone; recheck it`);
		}
	}
	const seen = new Map();
	for (const item of items) {
		const key = `${item.type}:${item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
		if (seen.has(key)) {
			problems.push(`${item.id} and ${seen.get(key)} have the same title; merge them or tell them apart`);
		}
		seen.set(key, item.id);
	}
	const terms = items.filter(item => item.type === 'term');
	for (const term of terms) {
		for (const alias of term.fields.avoid ?? []) {
			const clash = terms.find(other => other !== term && other.title.toLowerCase() === alias.toLowerCase());
			if (clash) {
				problems.push(`${term.id} avoids "${alias}", which is the name of ${clash.id}`);
			}
		}
	}
	const dimensions = items.filter(item => item.type === 'dimension');
	const directions = items.filter(item => item.type === 'direction' && item.status !== 'rejected');
	for (const direction of directions) {
		const missing = dimensions.filter(m => !direction.fields.choices[m.id]);
		if (missing.length) {
			problems.push(`${direction.id} makes no choice on ${missing.map(m => m.id).join(', ')}`);
		}
	}
	for (let i = 0; i < directions.length; i++) {
		for (let j = i + 1; j < directions.length; j++) {
			const [a, b] = [directions[i], directions[j]];
			const differ = dimensions.filter(m => a.fields.choices[m.id] !== b.fields.choices[m.id]).length;
			if (differ < 2) {
				problems.push(`${a.id} and ${b.id} differ on ${differ} dimension${differ === 1 ? '' : 's'}; directions must differ on at least two`);
			}
		}
	}
	const pending = pendingSources(state);
	if (pending.length) {
		warnings.push(`${pending.length} sources are waiting for extraction: ${pending.map(s => s.id).join(', ')}`);
	}
	return { problems, warnings };
}

// ---------- command line ----------

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2);
			if (BOOLEAN.has(key)) {
				flags[key] = true;
			} else if (argv[i + 1] === undefined) {
				fail(`--${key} needs a value`);
			} else {
				flags[key] = argv[++i];
			}
		} else {
			positional.push(argv[i]);
		}
	}
	return { positional, flags };
}

function main(argv) {
	const { positional: [command, ...rest], flags } = parseArgs(argv);
	const out = text => console.log(text);
	if (!command) {
		out(USAGE);
		return 0;
	}
	if (command === 'topics') {
		if (!existsSync(HOME)) {
			out(`No topics yet in ${HOME}.`);
			return 0;
		}
		for (const name of readdirSync(HOME).filter(name => existsSync(join(HOME, name, 'ledger')))) {
			const state = load(join(HOME, name));
			const last = [...state.runs.values()].at(-1);
			out(`${name}: ${frameTitle(state, name)}; ${activeItems(state).length} items; last run ${last ? `${last.id} ${(last.finished ?? last.started).slice(0, 10)}${last.finished ? '' : ' (open)'}` : 'none'}`);
		}
		return 0;
	}
	if (command === 'init') {
		const dir = topicDir(flags, { create: true });
		mkdirSync(join(dir, 'ledger'), { recursive: true });
		for (const name of ['runs', 'sources', 'evidence', 'items', 'links']) {
			const path = join(dir, 'ledger', `${name}.jsonl`);
			if (!existsSync(path)) {
				writeFileSync(path, '');
			}
		}
		if (!existsSync(join(dir, 'frame.md'))) {
			copyFileSync(TEMPLATE, join(dir, 'frame.md'));
		}
		if (!existsSync(join(dir, '.git')) && git(dir, 'init', '-q').status !== 0) {
			out('note: git is unavailable, so runs will not be committed');
		}
		render(load(dir), flags.topic);
		out(dir);
		return 0;
	}

	const dir = topicDir(flags);
	const readOnly = READ_ONLY.has(command) || (command === 'apply' && flags['dry-run']);
	return readOnly ? dispatch(load(dir), command, rest, flags) : withLock(dir, () => dispatch(load(dir), command, rest, flags));
}

// Subagents may run ledger commands at the same time, so every write holds a lock.
function withLock(dir, fn) {
	const lock = join(dir, 'ledger', '.lock');
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
			let age = 0;
			try {
				age = Date.now() - statSync(lock).mtimeMs;
			} catch {
				continue;
			}
			if (age > 120_000) {
				rmSync(lock, { recursive: true, force: true });
			} else if (Date.now() > deadline) {
				fail(`another ledger command holds ${lock}; if none is running, delete it`);
			} else {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
			}
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function dispatch(state, command, rest, flags) {
	const out = text => console.log(text);
	switch (command) {
		case 'run': {
			if (rest[0] === 'start') {
				const open = openRun(state);
				if (open) {
					out(`${open.id} is still open (started ${open.started.slice(0, 16)}); continuing it`);
					return 0;
				}
				const run = { id: nextId(state.runs, 'R'), started: now(), note: flags.note };
				append(state, 'runs', run);
				out(run.id);
				return 0;
			}
			if (rest[0] === 'finish') {
				const run = openRun(state) ?? fail('no open run');
				const done = { ...run, finished: now() };
				append(state, 'runs', done);
				state.runs.set(run.id, done);
				render(state, flags.topic);
				const path = join(state.dir, 'CHANGELOG.md');
				const previous = existsSync(path) ? readFileSync(path, 'utf8').replace(/^# Changelog\n+/, '') : '';
				const entry = changelogEntry(state, done);
				writeFileSync(path, `# Changelog\n\n${entry}\n\n${previous}`.trimEnd() + '\n');
				out(entry);
				if (existsSync(join(state.dir, '.git'))) {
					git(state.dir, 'add', '-A');
					const commit = git(state.dir, 'commit', '-q', '-m', `${run.id}${run.note ? `: ${run.note}` : ''}`);
					if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
						out(`note: git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
					}
				}
				return 0;
			}
			return fail('use `run start` or `run finish`');
		}
		case 'scan': {
			const dir = rest[0] ?? fail('scan needs a directory');
			if (!existsSync(dir) || !statSync(dir).isDirectory()) {
				fail(`${dir} is not a directory`);
			}
			const { counts, skipped } = scan(state, dir, { kind: flags.kind, group: flags.group });
			out(Object.entries(counts).map(([key, n]) => `${n} ${key}`).join(', '));
			skipped.slice(0, 20).forEach(path => out(`  skipped (binary, empty, or over 2 MB): ${path}`));
			const pending = pendingSources(state);
			out(`${pending.length} sources waiting for extraction, about ${Math.round(pending.reduce((n, s) => n + s.chars, 0) / 4).toLocaleString('en-US')} tokens`);
			return 0;
		}
		case 'source': {
			if (rest[0] === 'add') {
				const uri = rest[1] ?? fail('source add needs a uri');
				let text;
				let resolvedUri = uri;
				if (flags.from) {
					text = flags.from === '-' ? readFileSync(0, 'utf8') : readFileSync(flags.from, 'utf8');
				} else if (existsSync(uri) && statSync(uri).isFile()) {
					resolvedUri = resolve(uri);
					text = readTextFile(resolvedUri) ?? fail(`${uri} is not a text file`);
				} else {
					fail(`${uri} is not a local file; save its text and pass --from <file>, or pipe it with --from -`);
				}
				if (!text.trim()) {
					fail('the source text is empty');
				}
				const { status, source } = addSource(state, { uri: resolvedUri, text, kind: flags.kind, title: flags.title, group: flags.group, date: flags.date });
				out(`${source.id} ${status}: ${snapshotPath(state.dir, source)}`);
				return 0;
			}
			if (rest[0] === 'gone') {
				const source = state.sources.get(rest[1]) ?? fail(`unknown source ${rest[1]}`);
				markGone(state, source);
				out(`${source.id} gone`);
				return 0;
			}
			return fail('use `source add` or `source gone`');
		}
		case 'pending': {
			const pending = pendingSources(state);
			for (const source of pending) {
				const text = readFileSync(snapshotPath(state.dir, source), 'utf8');
				out(`${source.id} ${source.extracted ? 'changed' : 'new'} ${source.kind} ${source.chars} chars, ${text.split('\n').length} lines: ${source.title}\n  ${snapshotPath(state.dir, source)}`);
			}
			out(`${pending.length} pending, about ${Math.round(pending.reduce((n, s) => n + s.chars, 0) / 4).toLocaleString('en-US')} tokens`);
			return 0;
		}
		case 'apply': {
			const path = rest[0] ?? fail('apply needs a patch file');
			let patch;
			try {
				patch = JSON.parse(readFileSync(path, 'utf8'));
			} catch (error) {
				fail(`${path}: ${error.message}`);
			}
			const result = applyPatch(state, patch, { dropInvalid: flags['drop-invalid'], dryRun: flags['dry-run'] });
			result.errors.forEach(error => out(`${result.ok ? 'dropped' : 'invalid'}: ${error}`));
			if (!result.ok) {
				out('Nothing applied. Fix the ops above, or rerun with --drop-invalid to apply the rest.');
				return 1;
			}
			out(`${flags['dry-run'] ? 'would write' : 'wrote'} ${result.writes} records${result.errors.length ? `, dropped ${result.errors.length} ops` : ''}`);
			Object.entries(result.refs).forEach(([ref, id]) => out(`  $${ref} = ${id}`));
			return 0;
		}
		case 'list': {
			let items = flags.status ? [...state.items.values()].filter(item => item.status === flags.status) : activeItems(state);
			if (flags.type) {
				items = items.filter(item => item.type === checkEnum('type', flags.type, Object.keys(TYPES)));
			}
			if (flags.stale) {
				items = items.filter(item => itemStale(state, item));
			}
			if (flags.run) {
				const touched = new Set(state.raw.items.filter(record => record.run === flags.run).map(record => record.id));
				items = items.filter(item => touched.has(item.id));
			}
			for (const type of Object.keys(TYPES)) {
				const list = items.filter(item => item.type === type);
				if (list.length) {
					out(`${type} (${list.length})`);
					list.forEach(item => out(`  ${summary(state, item)}`));
				}
			}
			return 0;
		}
		case 'show': {
			if (!rest.length) {
				fail('show needs one or more ids');
			}
			for (const id of rest) {
				if (id.startsWith('E-')) {
					const ev = state.evidence.get(id) ?? fail(`unknown evidence ${id}`);
					const citedBy = [...state.items.values()].filter(item => active(item) && item.evidence?.includes(id)).map(item => item.id);
					out(`${ev.id} from ${ev.src}${ev.loc ? ` ${ev.loc}` : ''} (${ev.kind}, ${ev.speaker}${isStale(state, ev) ? ', stale' : ''}${ev.retracted ? `, retracted: ${ev.reason}` : ''})\n  "${ev.quote}"${ev.note ? `\n  note: ${ev.note}` : ''}\n  about: ${ev.about.join(', ') || '-'}\n  cited by: ${citedBy.join(', ') || 'nothing'}`);
				} else if (id.startsWith('S-')) {
					const source = state.sources.get(id) ?? fail(`unknown source ${id}`);
					out(`${source.id} ${source.kind} ${source.status}: ${source.title}\n  uri: ${source.uri}\n  snapshot: ${snapshotPath(state.dir, source)}\n  evidence: ${[...state.evidence.values()].filter(ev => ev.src === id && !ev.retracted).length}`);
				} else {
					const item = state.items.get(id);
					if (!item || !TYPE_BY_PREFIX[id.split('-')[0]]) {
						fail(`unknown id ${id}`);
					}
					out(describeItem(state, item));
				}
			}
			return 0;
		}
		case 'evidence': {
			const cited = new Set(activeItems(state).flatMap(item => item.evidence ?? []));
			let list = [...state.evidence.values()].filter(ev => !ev.retracted);
			if (flags.run) {
				const ids = new Set(state.raw.evidence.filter(record => record.run === flags.run).map(record => record.id));
				list = list.filter(ev => ids.has(ev.id));
			}
			if (flags.src) {
				list = list.filter(ev => ev.src === flags.src);
			}
			if (flags.uncited) {
				list = list.filter(ev => !cited.has(ev.id));
			}
			const groups = new Map();
			for (const ev of list) {
				const tag = ev.about[0] ?? '(untagged)';
				groups.set(tag, [...(groups.get(tag) ?? []), ev]);
			}
			for (const [tag, evs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
				out(`${tag} (${evs.length})`);
				evs.forEach(ev => out(`  ${ev.id} ${ev.src} (${ev.kind}, ${ev.speaker}): "${ev.quote}"${ev.note ? ` [${ev.note}]` : ''}`));
			}
			out(`${list.length} evidence quotes`);
			return 0;
		}
		case 'sample': {
			const count = Number(flags.count ?? 10);
			let items = activeItems(state).filter(item => TYPES[item.type].graded && liveEvidence(state, item).length);
			if (flags.run) {
				const touched = new Set(state.raw.items.filter(record => record.run === flags.run).map(record => record.id));
				items = items.filter(item => touched.has(item.id));
			}
			const order = { high: 0, medium: 1, low: 2 };
			items.sort((a, b) => order[grade(state, a)] - order[grade(state, b)]);
			items.slice(0, count).forEach(item => out(`${describeItem(state, item)}\n`));
			return 0;
		}
		case 'lint': {
			const { problems, warnings } = lint(state);
			problems.forEach(problem => out(`problem: ${problem}`));
			warnings.forEach(warning => out(`warning: ${warning}`));
			out(`${problems.length} problems, ${warnings.length} warnings`);
			return problems.length ? 1 : 0;
		}
		case 'render': {
			out(render(state, flags.topic).map(name => join(state.dir, 'views', name)).join('\n'));
			return 0;
		}
		default:
			return fail(`unknown command ${command}\n\n${USAGE}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		if (!(error instanceof UserError)) {
			throw error;
		}
		console.error(`ledger: ${error.message}`);
		process.exitCode = 1;
	}
}
