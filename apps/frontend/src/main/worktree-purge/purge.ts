/**
 * Free the disk space of the worktrees whose work is over.
 *
 * Every Kanban card (and every page that writes code, generated-review/)
 * works in `.workpilot/worktrees/tasks/<spec>`: a full checkout of the
 * project, build outputs and dependencies included. Once the card's pull
 * request is merged, or the card is done, archived or abandoned, that
 * folder holds nothing the forge does not. Purging it removes the folder and
 * the card's local branch `workpilot/<spec>`; the card, its spec and its PR
 * stay.
 *
 * A worktree with changes that are not committed is never purged: removing
 * it would lose them (`cleanupWorktree` would commit them on the branch it
 * then deletes). A card another card is stacked on keeps its branch until
 * that card has moved (split parts, F6).
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Project, Task } from "../../shared/types";
import type { PurgeCandidate, PurgeOutcome, PurgeReason } from "../../shared/types/worktree-purge";
import { isServerTask } from "../../shared/utils/task-split";
import { getToolPath } from "../cli-tool-manager";
import { getIsolatedGitEnv } from "../utils/git-isolation";
import { cleanupWorktree } from "../utils/worktree-cleanup";
import { getTaskWorktreePath } from "../worktree-paths";

const execute = promisify(execFile);

export type { PurgeCandidate, PurgeOutcome, PurgeReason };

export interface PurgeDeps {
	readonly isDirty: (worktree: string) => Promise<boolean>;
	readonly sizeOf: (dir: string) => Promise<number>;
	readonly remove: (project: Project, task: Task, worktree: string) => Promise<{ success: boolean; error?: string }>;
}

/** The reason a card's worktree may be purged, or null while its work goes on. */
export function purgeReason(task: Task): PurgeReason | null {
	const meta = task.metadata;
	if (meta?.prMergedAt) return "merged";
	if (meta?.archivedAt) return "archived";
	if (meta?.abandoned) return "abandoned";
	if (task.status === "done") return "done";
	return null;
}

/** Cards stacked on `task` that have not moved off it yet. */
function hasStackedChild(task: Task, tasks: readonly Task[]): boolean {
	return tasks.some(
		(other) =>
			other.id !== task.id &&
			other.status !== "done" &&
			(other.metadata?.stackParent === task.specId || other.metadata?.stackParent === task.id),
	);
}

/** Changes in the worktree that no commit holds (WorkPilot's own files aside). */
export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
	try {
		const { stdout } = await execute(
			getToolPath("git"),
			["status", "--porcelain", "--", ".", ":!.workpilot", ":!.workpilot-*"],
			{ cwd: worktree, encoding: "utf-8", env: getIsolatedGitEnv(), windowsHide: true, timeout: 30_000 },
		);
		return stdout.trim().length > 0;
	} catch {
		// A worktree git cannot read is not known to be clean.
		return true;
	}
}

/** Bytes under `dir`, without following links. */
export async function directorySize(dir: string): Promise<number> {
	let total = 0;
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
			} else if (entry.isFile()) {
				try {
					total += (await lstat(full)).size;
				} catch {
					// Gone meanwhile.
				}
			}
		}
	}
	return total;
}

const defaultDeps: PurgeDeps = {
	isDirty: hasUncommittedChanges,
	sizeOf: directorySize,
	remove: async (project, task, worktree) => {
		const result = await cleanupWorktree({
			worktreePath: worktree,
			projectPath: project.path,
			specId: task.specId,
			deleteBranch: true,
			logPrefix: "[WorktreePurge]",
		});
		return { success: result.success, error: result.warnings.join(" ") || undefined };
	},
};

function worktreeOf(project: Project, task: Task): string | null {
	const worktree = getTaskWorktreePath(project.path, task.specId);
	if (!worktree || !existsSync(worktree)) return null;
	try {
		// A link in place of the folder is not a worktree WorkPilot made.
		return lstatSync(worktree).isDirectory() ? worktree : null;
	} catch {
		return null;
	}
}

/** The worktrees of `tasks` that may be purged, with their size. */
export async function listPurgeCandidates(
	project: Project,
	tasks: readonly Task[],
	deps: PurgeDeps = defaultDeps,
): Promise<PurgeCandidate[]> {
	const candidates: PurgeCandidate[] = [];
	for (const task of tasks) {
		if (isServerTask(task)) continue;
		const reason = purgeReason(task);
		if (!reason || hasStackedChild(task, tasks)) continue;
		const worktree = worktreeOf(project, task);
		if (!worktree) continue;
		candidates.push({
			taskId: task.id,
			specId: task.specId,
			title: task.title,
			reason,
			path: worktree,
			bytes: await deps.sizeOf(worktree),
			dirty: await deps.isDirty(worktree),
		});
	}
	return candidates;
}

/** Purge the worktrees of `specIds`, each checked again here. */
export async function purgeWorktrees(
	project: Project,
	tasks: readonly Task[],
	specIds: readonly string[],
	deps: PurgeDeps = defaultDeps,
): Promise<PurgeOutcome[]> {
	const outcomes: PurgeOutcome[] = [];
	for (const specId of specIds) {
		const task = tasks.find((t) => t.specId === specId);
		const worktree = task ? worktreeOf(project, task) : null;
		if (
			!task ||
			!worktree ||
			isServerTask(task) ||
			!purgeReason(task) ||
			hasStackedChild(task, tasks)
		) {
			outcomes.push({ specId, purged: false, bytes: 0, error: "not_purgeable" });
			continue;
		}
		if (await deps.isDirty(worktree)) {
			outcomes.push({ specId, purged: false, bytes: 0, error: "dirty" });
			continue;
		}
		const bytes = await deps.sizeOf(worktree);
		const result = await deps.remove(project, task, worktree);
		outcomes.push(
			result.success
				? { specId, purged: true, bytes }
				: { specId, purged: false, bytes: 0, error: "failed", message: result.error },
		);
	}
	return outcomes;
}

/** The worktrees of cards whose PR is merged: purged without asking. */
export function mergedSpecIds(project: Project, tasks: readonly Task[]): string[] {
	return tasks
		.filter((task) => purgeReason(task) === "merged" && worktreeOf(project, task) !== null)
		.map((task) => task.specId);
}
