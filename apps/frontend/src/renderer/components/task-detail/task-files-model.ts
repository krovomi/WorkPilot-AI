/**
 * What the task detail's "Fichiers" tab lists for the task's own changes.
 *
 * The tab used to list only the spec folder (spec.md, the plan, the JSON
 * artifacts), so a task that created `test.txt` showed nothing about it. The
 * files the task created, modified or deleted now come first:
 *
 *  1. the worktree's diff against its base (`getWorktreeDiff`), the same list
 *     as the review's "Fichiers modifiés": commits, uncommitted and untracked
 *     files of the task;
 *  2. when that list is empty or unavailable (the worktree is gone, or the
 *     branch is already merged so the diff against the base is empty), the
 *     files the subtasks recorded (`files_changed`, the git diff of each
 *     completed subtask), read from the project itself.
 */
import type { Subtask, WorktreeDiffFile } from "../../../shared/types";

export type TaskFileStatus = WorktreeDiffFile["status"] | "unknown";

export interface TaskFileEntry {
	/** Path relative to the repository root, with "/" separators. */
	path: string;
	status: TaskFileStatus;
	additions?: number;
	deletions?: number;
	/** The file's diff, shown when its content cannot be read. */
	patch?: string;
}

export interface TaskFilesResult {
	files: TaskFileEntry[];
	/** Folder the paths are relative to, used to read a file's content. */
	root: string | null;
	/** Where the list comes from, for the section's caption. */
	source: "worktree" | "subtasks" | "none";
	/** The worktree diff's error, when no list could replace it. */
	error: string | null;
}

/** Repository-relative, "/" separators, no leading "./". */
export function normalizeTaskFilePath(filePath: string): string {
	return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** The files the subtasks record, first-seen order, without duplicates. */
export function filesFromSubtasks(
	subtasks: Pick<Subtask, "files">[] | undefined,
): TaskFileEntry[] {
	const seen = new Set<string>();
	const entries: TaskFileEntry[] = [];
	for (const subtask of subtasks ?? []) {
		for (const raw of subtask.files ?? []) {
			if (typeof raw !== "string" || raw.trim() === "") continue;
			const filePath = normalizeTaskFilePath(raw.trim());
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			entries.push({ path: filePath, status: "unknown" });
		}
	}
	return entries;
}

/** Added files first (what the task created), then the others, by path. */
export function sortTaskFiles(files: TaskFileEntry[]): TaskFileEntry[] {
	const rank = (status: TaskFileStatus) => (status === "added" ? 0 : 1);
	return [...files].sort(
		(a, b) => rank(a.status) - rank(b.status) || a.path.localeCompare(b.path),
	);
}

interface ResolveInput {
	diff: { success: boolean; files?: WorktreeDiffFile[]; error?: string };
	worktreePath: string | null;
	projectPath: string | null;
	subtasks: Pick<Subtask, "files">[] | undefined;
}

/** Combine the worktree diff and the subtasks' record into the tab's list. */
export function resolveTaskFiles({
	diff,
	worktreePath,
	projectPath,
	subtasks,
}: ResolveInput): TaskFilesResult {
	const diffFiles = diff.success ? (diff.files ?? []) : [];
	if (diffFiles.length > 0) {
		return {
			files: sortTaskFiles(
				diffFiles.map((file) => ({
					path: normalizeTaskFilePath(file.path),
					status: file.status,
					additions: file.additions,
					deletions: file.deletions,
					patch: file.patch,
				})),
			),
			root: worktreePath,
			source: "worktree",
			error: null,
		};
	}

	const recorded = filesFromSubtasks(subtasks);
	if (recorded.length > 0) {
		// The worktree no longer holds the changes (merged, cleaned up): the
		// project has them. A still-present worktree is read first, since an
		// unmerged branch's version is the one the task wrote.
		return {
			files: sortTaskFiles(recorded),
			root: worktreePath ?? projectPath,
			source: "subtasks",
			error: null,
		};
	}

	return {
		files: [],
		root: worktreePath,
		source: "none",
		// "No worktree" is the normal state of a task that has not started:
		// it is not an error to show.
		error:
			diff.success || !worktreePath ? null : (diff.error ?? "Unknown error"),
	};
}
