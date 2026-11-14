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
import { getEffectiveBaseBranch, gitRefExists } from "../ipc-handlers/task/worktree-git-refs";
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

function lines(output: string | null, separator: string | RegExp): string[] {
	return (output ?? "")
		.split(separator)
		.map((line) => line.trim())
		.filter(Boolean);
}

export async function readWorktreeChangedFiles(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): Promise<string[] | null> {
	const worktree = findTaskWorktree(projectPath, specId);
	if (!worktree) return null;

	const base = getEffectiveBaseBranch(projectPath, specId, projectMainBranch);
	const baseRef = gitRefExists(worktree, base)
		? base
		: gitRefExists(worktree, `origin/${base}`)
			? `origin/${base}`
			: null;
	if (!baseRef) return null;
	const mergeBase = (await git(worktree, ["merge-base", baseRef, "HEAD"]))?.trim();
	if (!mergeBase) return null;

	const changed = await git(worktree, ["diff", "--name-only", "-z", mergeBase]);
	if (changed === null) return null;
	const untracked = await git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]);

	const files = new Set<string>();
	for (const file of [...lines(changed, "\0"), ...lines(untracked, "\0")]) {
		if (isWorkpilotArtifact(file) || isBuildOutputPath(file)) continue;
		files.add(file);
		if (files.size >= MAX_WORKTREE_FILES) break;
	}
	return [...files];
}
