/**
 * Word-level diff of a rewritten line: which parts of the old line were
 * removed and which parts of the new line were added, so the view can mark
 * them on top of the line colour (GitHub / VS Code "inline changes").
 */

/** A [from, to) character range of a line. */
export interface TextRange {
	from: number;
	to: number;
}

export interface WordDiff {
	removed: TextRange[];
	added: TextRange[];
}

// Identifiers and numbers stay whole; runs of spaces and each symbol stand alone.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

/** Past this many tokens per side the LCS table gets costly: no word diff. */
const MAX_TOKENS = 400;

/**
 * Under this share of unchanged characters the two lines are not a rewrite
 * but different lines: marking words would light up nearly everything.
 */
const MIN_SIMILARITY = 0.4;

function tokenize(text: string): string[] {
	return text.match(TOKEN) ?? [];
}

function toRanges(tokens: string[], changed: boolean[]): TextRange[] {
	const ranges: TextRange[] = [];
	let offset = 0;
	for (let i = 0; i < tokens.length; i++) {
		const end = offset + tokens[i].length;
		if (changed[i]) {
			const last = ranges[ranges.length - 1];
			if (last && last.to === offset) last.to = end;
			else ranges.push({ from: offset, to: end });
		}
		offset = end;
	}
	return ranges;
}

/**
 * The changed words between an old line and the line it became, or null when
 * there is nothing useful to mark (identical, too different, or too long).
 */
export function diffWords(oldText: string, newText: string): WordDiff | null {
	if (oldText === newText) return null;
	const a = tokenize(oldText);
	const b = tokenize(newText);
	if (a.length === 0 || b.length === 0) return null;
	if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

	// Longest common subsequence of tokens, table filled from the end.
	const width = b.length + 1;
	const table = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}

	const removed = new Array<boolean>(a.length).fill(true);
	const added = new Array<boolean>(b.length).fill(true);
	let common = 0;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			removed[i] = false;
			added[j] = false;
			common += a[i].trim().length;
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}

	// Similarity on visible characters: shared indentation alone does not
	// make two lines a rewrite of each other.
	const visible = Math.max(
		oldText.replace(/\s/g, "").length,
		newText.replace(/\s/g, "").length,
	);
	if (visible === 0 || common / visible < MIN_SIMILARITY) return null;

	return { removed: toRanges(a, removed), added: toRanges(b, added) };
}
