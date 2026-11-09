import type { SyntaxToken } from "./diff-syntax";
import type { TextRange } from "./diff-words";

/** A piece of a line with one syntax class and whether it is a changed word. */
export interface LineSegment {
	/** Offset of the piece in the line (stable React key). */
	from: number;
	text: string;
	className?: string;
	changed: boolean;
}

function covering<T extends TextRange>(
	ranges: readonly T[],
	from: number,
): T | undefined {
	return ranges.find((range) => range.from <= from && from < range.to);
}

/**
 * Cut a line where its syntax tokens or its changed words start or end, so
 * each piece carries one colour and one "changed word" mark.
 */
export function splitLine(
	content: string,
	tokens: readonly SyntaxToken[] = [],
	words: readonly TextRange[] = [],
): LineSegment[] {
	if (tokens.length === 0 && words.length === 0) {
		return [{ from: 0, text: content, changed: false }];
	}
	const cuts = new Set<number>([0, content.length]);
	for (const range of [...tokens, ...words]) {
		cuts.add(Math.min(Math.max(range.from, 0), content.length));
		cuts.add(Math.min(Math.max(range.to, 0), content.length));
	}
	const points = [...cuts].sort((a, b) => a - b);
	const segments: LineSegment[] = [];
	for (let k = 0; k < points.length - 1; k++) {
		const from = points[k];
		const to = points[k + 1];
		if (to <= from) continue;
		segments.push({
			from,
			text: content.slice(from, to),
			className: covering(tokens, from)?.className,
			changed: covering(words, from) !== undefined,
		});
	}
	return segments;
}
