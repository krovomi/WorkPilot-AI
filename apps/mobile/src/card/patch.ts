/** A file's unified diff, cut into the lines the patch view colours. */

export type PatchLineKind = "added" | "removed" | "hunk" | "meta" | "context";

export interface PatchLine {
	/** Its place in the diff, from 0: a diff's lines repeat, so this is their identity. */
	n: number;
	kind: PatchLineKind;
	text: string;
}

/** The most lines drawn for one file; a phone is not where to read a 10 000-line diff. */
export const MAX_PATCH_LINES = 400;

export function patchLines(patch: string): { lines: PatchLine[]; truncated: boolean } {
	const all = patch.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	const lines = all.slice(0, MAX_PATCH_LINES).map((text, n): PatchLine => ({ n, kind: kindOf(text), text }));
	return { lines, truncated: all.length > MAX_PATCH_LINES };
}

function kindOf(text: string): PatchLineKind {
	if (text.startsWith("@@")) return "hunk";
	if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary )/.test(text)) return "meta";
	if (text.startsWith("+")) return "added";
	if (text.startsWith("-")) return "removed";
	return "context";
}
