/**
 * A review comment anchored on a line of the task's diff
 * (`apps/backend/foundation/review_comments.py`, `docs/architecture/review-comments.md`).
 */

/** open → addressed (the fixer's diff touched it) → resolved (the person); stale: its lines are gone. */
export type ReviewCommentStatus = "open" | "addressed" | "resolved" | "stale";

export interface ReviewComment {
	id: string;
	/** Relative to the worktree, forward slashes. */
	path: string;
	/** "new": a line of the task's version; "old": a removed line of the base. */
	side: "new" | "old";
	line: number;
	/** The commit the comment was written on. */
	commit: string;
	/** The lines around the anchor, to find it again when lines move. */
	excerpt: string[];
	/** Index of the commented line within `excerpt`. */
	excerptOffset: number;
	text: string;
	status: ReviewCommentStatus;
	createdAt: string;
	updatedAt: string;
	addressedSession?: number | null;
}

/** What the renderer may send: a place and a text. The rest is the main process's. */
export interface ReviewCommentInput {
	path: string;
	side: "new" | "old";
	line: number;
	text: string;
	/**
	 * The commit whose version of the file the line number is in (the group's
	 * `from` for a removed line, `to` otherwise). Absent: the worktree, or HEAD
	 * for a removed line.
	 */
	commit?: string;
}
