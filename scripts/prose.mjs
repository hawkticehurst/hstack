// Shared prose rule for hstack: The first word after a colon is capitalized.
// Used by scripts/check.mjs to report violations and by `--fix` to correct them.

// Words that keep their own casing after a colon: Tools, commands, and hstack's own lowercase name.
const KEEP = new Set(['hstack', 'npm', 'npx', 'gh', 'git', 'node', 'pnpm', 'bun', 'macOS', 'iOS', 'iPhone', 'iPadOS', 'jq']);

// A colon right after a word, `code`, a closing parenthesis or quote, or bold/italic markers,
// then optional closing markers, a space, optional opening markers, and a lowercase word.
const COLON_WORD = /([\p{L}\p{N}`)"'*_\]\u0000])(:)(\*\*|\*|_)?( +)(\*\*|\*|_|")?(\p{Ll}[\p{L}\p{N}'’-]*)/gu;
const FENCE = /^\s*(```|~~~)/;
const INLINE = /(`+)[^`]*?\1|\]\([^)]*\)|<[^>\n]+>|https?:\/\/\S+/g;

/** Applies the rule to one line of prose. Returns { text, hits } with hits = the words changed. */
export function capitalizeAfterColons(line) {
	const hits = [];
	// Mask inline code, link targets, HTML tags, and URLs so they are never touched.
	const masks = [];
	const masked = line.replace(INLINE, match => {
		masks.push(match);
		return `\u0000${masks.length - 1}\u0000`;
	});
	const fixed = masked.replace(COLON_WORD, (all, before, colon, closer = '', space, opener = '', word, offset) => {
		// Words that continue as a path, ref, or URL (origin/main, src/vs) keep their casing.
		const rest = masked.slice(offset + all.length);
		if (KEEP.has(word) || /^\d/.test(word) || /^[/.:@]\S/.test(rest)) {
			return all;
		}
		hits.push(word);
		return `${before}${colon}${closer}${space}${opener}${word[0].toUpperCase()}${word.slice(1)}`;
	});
	return { text: fixed.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)]), hits };
}

/**
 * Applies the rule to a Markdown file's prose: everything outside code fences, plus the value of
 * a `description:` line in front matter. Other front matter keys are left alone.
 */
export function capitalizeMarkdown(text) {
	const lines = text.split('\n');
	const hits = [];
	let inFence = false;
	let inFrontmatter = lines[0] === '---';
	lines.forEach((line, index) => {
		if (inFrontmatter) {
			if (index > 0 && line === '---') {
				inFrontmatter = false;
				return;
			}
			const match = /^(description:\s*)(.*)$/.exec(line);
			if (match) {
				const result = capitalizeAfterColons(match[2]);
				lines[index] = match[1] + result.text;
				result.hits.forEach(word => hits.push({ line: index + 1, word }));
			}
			return;
		}
		if (FENCE.test(line)) {
			inFence = !inFence;
			return;
		}
		if (!inFence) {
			const result = capitalizeAfterColons(line);
			lines[index] = result.text;
			result.hits.forEach(word => hits.push({ line: index + 1, word }));
		}
	});
	return { text: lines.join('\n'), hits };
}
