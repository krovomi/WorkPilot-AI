/**
 * Pure model of a unified git patch, shared by every diff view of the app:
 * typed lines with their numbers, side-by-side rows, the unchanged lines a hunk
 * skips, and the layout to show (unified or side by side) for a given patch.
 */

/** "auto" picks the layout per file: see {@link resolveDiffLayout}. */
export type DiffViewMode = "auto" | "unified" | "split";
export type DiffLayout = "unified" | "split";

export interface DiffLine {
	content: string;
	type: "context" | "added" | "removed" | "hunk";
	oldLineNumber?: number;
	newLineNumber?: number;
	/** Hunk only: unchanged lines git left out between the previous hunk and this one. */
	hiddenBefore?: number;
	/** Hunk only: the enclosing function or class git prints after the second `@@`. */
	section?: string;
	/** Hunk only: the `@@ -a,b +c,d @@` range, without the section. */
	range?: string;
}

/** A single row of the side-by-side view, pairing an old line with a new one. */
export interface SplitRow {
	type: "context" | "change" | "hunk";
	left?: DiffLine;
	right?: DiffLine;
	/** Index in the parsed lines of `left` / `right` (to look up their highlighting). */
	leftIndex?: number;
	rightIndex?: number;
}

const HEADER_LINE =
	/^(index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;
const HUNK_HEADER = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)(.*)$/;

export function parseDiff(patch: string): DiffLine[] {
	const lines = patch.split("\n");
	const result: DiffLine[] = [];
	let oldLineNumber = 0;
	let newLineNumber = 0;
	let inHunk = false;
	// Last old-side line shown, to count the unchanged lines between two hunks.
	let lastOldShown = 0;

	for (const raw of lines) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			lastOldShown = 0;
			continue;
		}
		if (!inHunk && HEADER_LINE.test(line)) continue;
		if (!line || line.startsWith("\\ No newline")) continue;

		if (line.startsWith("@@")) {
			inHunk = true;
			const match = line.match(HUNK_HEADER);
			if (!match) {
				result.push({ content: line, type: "hunk", range: line });
				continue;
			}
			const oldStart = Number.parseInt(match[2], 10);
			oldLineNumber = oldStart - 1;
			newLineNumber = Number.parseInt(match[4], 10) - 1;
			// "-5,0" is a pure insertion after old line 5: lines up to 5 are
			// skipped. A new file starts at -0,0: nothing hidden before it.
			const pureInsertion = match[3] === "0";
			const firstShown = pureInsertion ? oldStart + 1 : oldStart;
			const hiddenBefore = Math.max(0, firstShown - 1 - lastOldShown);
			if (pureInsertion) lastOldShown = oldStart;
			const section = match[6].trim();
			result.push({
				content: line,
				type: "hunk",
				range: match[1],
				section: section || undefined,
				hiddenBefore,
			});
			continue;
		}

		if (line.startsWith("+")) {
			newLineNumber++;
			result.push({ content: line.substring(1), type: "added", newLineNumber });
		} else if (line.startsWith("-")) {
			oldLineNumber++;
			lastOldShown = oldLineNumber;
			result.push({
				content: line.substring(1),
				type: "removed",
				oldLineNumber,
			});
		} else if (line.startsWith(" ")) {
			oldLineNumber++;
			newLineNumber++;
			lastOldShown = oldLineNumber;
			result.push({
				content: line.substring(1),
				type: "context",
				oldLineNumber,
				newLineNumber,
			});
		} else {
			// Other lines (file headers, etc.)
			result.push({ content: line, type: "context" });
		}
	}

	return result;
}

/**
 * Pair unified diff lines into side-by-side rows. Context and hunk lines map to
 * a single row; a run of removed/added lines is zipped so the k-th removal sits
 * opposite the k-th addition (extra lines on either side get an empty cell),
 * mirroring GitHub's split view.
 */
export function buildSplitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line.type === "hunk" || line.type === "context") {
			rows.push({
				type: line.type,
				left: line,
				right: line,
				leftIndex: i,
				rightIndex: i,
			});
			i++;
			continue;
		}
		// Gather the maximal run of consecutive changed lines, then zip the
		// removals against the additions.
		const removed: number[] = [];
		const added: number[] = [];
		while (
			i < lines.length &&
			(lines[i].type === "removed" || lines[i].type === "added")
		) {
			if (lines[i].type === "removed") removed.push(i);
			else added.push(i);
			i++;
		}
		const max = Math.max(removed.length, added.length);
		for (let k = 0; k < max; k++) {
			rows.push({
				type: "change",
				left: removed[k] === undefined ? undefined : lines[removed[k]],
				right: added[k] === undefined ? undefined : lines[added[k]],
				leftIndex: removed[k],
				rightIndex: added[k],
			});
		}
	}

	return rows;
}

/**
 * For each removed line, the added line it was rewritten into (and back), the
 * same pairing as the side-by-side view: the k-th removal of a run of changes
 * faces its k-th addition. Used for the word-level highlighting.
 */
export function pairChangedLines(lines: DiffLine[]): Map<number, number> {
	const pairs = new Map<number, number>();
	for (const row of buildSplitRows(lines)) {
		if (
			row.type === "change" &&
			row.leftIndex !== undefined &&
			row.rightIndex !== undefined
		) {
			pairs.set(row.leftIndex, row.rightIndex);
			pairs.set(row.rightIndex, row.leftIndex);
		}
	}
	return pairs;
}

export interface DiffCounts {
	additions: number;
	deletions: number;
}

export function countChanges(lines: DiffLine[]): DiffCounts {
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.type === "added") additions++;
		else if (line.type === "removed") deletions++;
	}
	return { additions, deletions };
}

/** Under this width (px) two columns of code are too narrow to read. */
export const SPLIT_MIN_WIDTH = 900;

/**
 * The layout a patch is shown in.
 * - A file that only gains or only loses lines (a new or deleted file) is
 *   always unified: side by side, one half would stay empty.
 * - "auto" puts old and new side by side when both have changes and the view
 *   is wide enough, else one column.
 * - "unified" / "split" are the person's explicit choice.
 */
export function resolveDiffLayout(
	mode: DiffViewMode,
	counts: DiffCounts,
	width?: number,
): DiffLayout {
	if (mode === "unified") return "unified";
	if (counts.additions === 0 || counts.deletions === 0) return "unified";
	if (mode === "split") return "split";
	return width !== undefined && width >= SPLIT_MIN_WIDTH ? "split" : "unified";
}

/**
 * The path a single-file patch is about (`+++ b/…`, else `--- a/…` for a
 * deleted file), or undefined when there is none or several files.
 */
export function patchFilePath(patch: string): string | undefined {
	let found: string | undefined;
	let files = 0;
	for (const line of patch.split("\n", 4000)) {
		if (line.startsWith("diff --git ")) files++;
		const target = line.match(/^\+\+\+ (?:b\/)?(.+?)\s*$/);
		if (target && target[1] !== "/dev/null") found ??= target[1];
		const source = line.match(/^--- (?:a\/)?(.+?)\s*$/);
		if (source && source[1] !== "/dev/null" && !found) found = source[1];
	}
	return files > 1 ? undefined : found;
}

// ── Persisted choice ────────────────────────────────────────────────────

// Shared by every diff view so the choice sticks across files and sessions.
// The key predates "auto"; its old values ("unified", "split") stay valid.
export const DIFF_VIEW_MODE_STORAGE_KEY = "workpilot.subtaskDiff.viewMode";

export function readStoredDiffViewMode(): DiffViewMode {
	try {
		const value = globalThis.localStorage?.getItem(DIFF_VIEW_MODE_STORAGE_KEY);
		return value === "split" || value === "unified" ? value : "auto";
	} catch {
		return "auto";
	}
}

export function storeDiffViewMode(mode: DiffViewMode): void {
	try {
		globalThis.localStorage?.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode);
	} catch {
		/* localStorage unavailable (quota / private mode): choice not persisted */
	}
}
