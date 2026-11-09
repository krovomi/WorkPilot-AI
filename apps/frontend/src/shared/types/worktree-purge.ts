/**
 * The worktrees « Purger » can remove (main/worktree-purge/): cards whose
 * pull request is merged, or that are done, archived or abandoned.
 */
export type PurgeReason = "merged" | "done" | "archived" | "abandoned";

export interface PurgeCandidate {
	readonly taskId: string;
	readonly specId: string;
	readonly title: string;
	readonly reason: PurgeReason;
	readonly path: string;
	/** Bytes on disk (links not followed). */
	readonly bytes: number;
	/** Changes that are not committed: the worktree stays. */
	readonly dirty: boolean;
}

export interface PurgeOutcome {
	readonly specId: string;
	readonly purged: boolean;
	readonly bytes: number;
	readonly error?: "dirty" | "not_purgeable" | "failed";
	readonly message?: string;
}
