/**
 * The guided review: a task's diff grouped by the plan's intentions
 * (`shared/utils/review-groups.ts`, `docs/architecture/guided-review.md`).
 */
import type { WorktreeDiffFile } from "./task";

/** A QA reviewer's issue, shown in the group of the file it names. */
export interface ReviewQaNote {
	file: string;
	line: number | null;
	title: string;
	severity: string;
}

/** A block removed in one place and added, unchanged, in another. */
export interface ReviewMovedBlock {
	/** "in": this file received the block; "out": it left this file. */
	direction: "in" | "out";
	/** The other end of the move. */
	otherPath: string;
	lines: number;
	/** The block's first line, to recognise it. */
	preview: string;
}

export interface ReviewGroupFile extends WorktreeDiffFile {
	/** Hash of the patch: what "viewed" remembers. */
	hash: string;
	/** No subtask announced this file in `files_to_modify` / `files_to_create`. */
	outOfPlan: boolean;
	/** Keys of the later groups that change this file again. */
	touchedLater: string[];
	moved: ReviewMovedBlock[];
	qaNotes: ReviewQaNote[];
}

export type ReviewGroupKind = "subtask" | "commit" | "uncommitted";

export interface ReviewGroup {
	/** Stable across refreshes: what "viewed" is keyed on. */
	key: string;
	kind: ReviewGroupKind;
	/** The subtask's title, the commit's subject; empty for uncommitted changes. */
	title: string;
	/** The planner's description: the explanation of the group. */
	description: string;
	subtaskId?: string;
	/** For a subtask recorded in several separate ranges: 1-based part, of `parts`. */
	part?: number;
	parts?: number;
	/** The commit range shown (`from..to`); absent for uncommitted changes. */
	from?: string;
	to?: string;
	files: ReviewGroupFile[];
}

export interface ReviewGroups {
	groups: ReviewGroup[];
	/** Files changed outside every subtask's announced files. */
	outOfPlan: string[];
	/** QA issues whose file no group changes. */
	unanchoredQa: ReviewQaNote[];
	/** Some subtask ranges were inferred from the previous record (older builds). */
	approximate: boolean;
}
