/**
 * Files a task's worktree has actually changed against its base branch:
 * commits, index, working tree and untracked files. Read with git by argument
 * list (no shell). Null when the task has no worktree or git cannot answer:
 * the planner then relies on the plan alone.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isBuildOutputPath } from "../../shared/utils/build-output-paths";
import { getToolPath } from "../cli-tool-manager";
import { isWorkpilotArtifact } from "../ipc-handlers/task/worktree-diff-handlers";
import { getEffectiveBaseBranch } from "../ipc-handlers/task/worktree-git-refs";
import { findTaskWorktree } from "../worktree-paths";

const execFileAsync = promisify(execFile);

/** Beyond this, a worktree's list is cut: enough to score, bounded in memory. */
export const MAX_WORKTREE_FILES = 2000;
const GIT_TIMEOUT_MS = 15_000;

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(getToolPath("git"), args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf-8",
		});
		return stdout;
	} catch {
		return null;
	}
}

/** Changes since the merge-base with `ref`, or null when git cannot say. */
async function changedSince(worktree: string, ref: string): Promise<string[] | null> {
	const mergeBase = await git(worktree, ["merge-base", ref, "HEAD"]);
	if (mergeBase === null) return null;
	const outputs = await Promise.all([
		git(worktree, ["diff", "--name-only", "-z", mergeBase.trim()]),
		git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]),
	]);
	// A list git could not give counts as empty (`join` writes null as "").
	return outputs
		.join("\0")
		.split("\0")
		.map((file) => file.trim())
		.filter(Boolean);
}

export async function readWorktreeChangedFiles(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): Promise<string[] | null> {
	const worktree = findTaskWorktree(projectPath, specId);
	if (!worktree) return null;

	// The local base branch first, then its remote copy (a clone that never
	// checked it out).
	const base = getEffectiveBaseBranch(projectPath, specId, projectMainBranch);
	for (const ref of [base, `origin/${base}`]) {
		const files = await changedSince(worktree, ref);
		if (files === null) continue;
		const kept = files.filter((file) => !isWorkpilotArtifact(file) && !isBuildOutputPath(file));
		return [...new Set(kept)].slice(0, MAX_WORKTREE_FILES);
	}
	return null;
}
