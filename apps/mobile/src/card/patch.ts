/** A file's unified diff, cut into the lines the patch view colours. */

export type PatchLineKind = "added" | "removed" | "hunk" | "meta" | "context";

export interface PatchLine {
	/** Its place in the diff, from 0: a diff's lines repeat, so this is their identity. */
	n: number;
	kind: PatchLineKind;
	text: string;
	/** The line's number in the file before and after the change, where it has one. */
	old?: number | null;
	new?: number | null;
}

/** The most lines drawn for one file on the card; a phone is not where to read a 10 000-line diff. */
export const MAX_PATCH_LINES = 400;
/** The most lines of the full-screen diff of one file. */
export const MAX_FULL_PATCH_LINES = 3_000;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function patchLines(patch: string, max = MAX_PATCH_LINES): { lines: PatchLine[]; truncated: boolean } {
	const all = patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	let before = 0;
	let after = 0;
	const lines = all.slice(0, max).map((text, n): PatchLine => {
		const kind = kindOf(text);
		if (kind === "hunk") {
			const start = HUNK.exec(text);
			before = start ? Number(start[1]) : 0;
			after = start ? Number(start[2]) : 0;
			return { n, kind, text, old: null, new: null };
		}
		if (kind === "meta" || before === 0 && after === 0) return { n, kind, text, old: null, new: null };
		if (kind === "added") return { n, kind, text, old: null, new: after++ };
		if (kind === "removed") return { n, kind, text, old: before++, new: null };
		return { n, kind, text, old: before++, new: after++ };
	});
	return { lines, truncated: all.length > max };
}

function kindOf(text: string): PatchLineKind {
	if (text.startsWith("@@")) return "hunk";
	if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary )/.test(text)) return "meta";
	if (text.startsWith("+")) return "added";
	if (text.startsWith("-")) return "removed";
	return "context";
}
