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

/** Changes since the merge-base: committed, staged, unstaged and untracked. */
async function changedSince(worktree: string, mergeBase: string): Promise<string[]> {
	const outputs = await Promise.all([
		git(worktree, ["diff", "--name-only", "-z", mergeBase]),
		git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"]),
	]);
	// A list git could not give counts as empty (`join` writes null as "").
	return outputs
		.join("\0")
		.split("\0")
		.map((file) => file.trim())
		.filter(Boolean);
}

/** A file of the task's own, not WorkPilot's and not build output. */
function isTaskFile(file: string): boolean {
	return !isWorkpilotArtifact(file) && !isBuildOutputPath(file);
}

/**
 * The task's worktree and the merge-base of its changes with the base branch:
 * the local branch first, then its remote copy (a clone that never checked it
 * out). Null when there is no worktree or git cannot say.
 */
async function worktreeBase(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): Promise<{ worktree: string; mergeBase: string } | null> {
	const worktree = findTaskWorktree(projectPath, specId);
	if (!worktree) return null;
	const base = getEffectiveBaseBranch(projectPath, specId, projectMainBranch);
	for (const ref of [base, `origin/${base}`]) {
		const mergeBase = await git(worktree, ["merge-base", ref, "HEAD"]);
		if (mergeBase !== null) return { worktree, mergeBase: mergeBase.trim() };
	}
	return null;
}

export async function readWorktreeChangedFiles(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): Promise<string[] | null> {
	const found = await worktreeBase(projectPath, specId, projectMainBranch);
	if (!found) return null;
	const files = await changedSince(found.worktree, found.mergeBase);
	return [...new Set(files.filter(isTaskFile))].slice(0, MAX_WORKTREE_FILES);
}

/** Path of a `diff --git a/<path> b/<path>` header: what follows the last ` b/`. */
function sectionPath(header: string): string {
	return header.slice(header.lastIndexOf(" b/") + 3);
}

/**
 * Keeps the sections of a unified diff whose file passes `keep`. A section
 * opens with its `diff --git` header; anything before the first is dropped.
 */
export function keepDiffSections(diff: string, keep: (file: string) => boolean): string {
	const kept: string[] = [];
	let keeping = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) keeping = keep(sectionPath(line));
		if (keeping) kept.push(line);
	}
	return kept.join("\n");
}

/** Where a spec's code is read from, and what its worktree changed. */
export interface SpecCodeSource {
	/** The task's worktree, or null when it has none. */
	worktree: string | null;
	/** Its diff since the merge-base, or null when git cannot say. */
	diff: string | null;
}

/**
 * The worktree's changes since its merge-base as a unified diff without
 * context (commits, index and working tree; untracked files only add),
 * WorkPilot's files and build output left out, with the worktree it was read
 * from. No external diff driver or text conversion runs (`--no-ext-diff`,
 * `--no-textconv`): a repository's attributes never pick a program here.
 * The diff is null when git cannot say (output over the cap included).
 */
export async function readWorktreeDiff(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): Promise<SpecCodeSource> {
	const found = await worktreeBase(projectPath, specId, projectMainBranch);
	if (!found) return { worktree: findTaskWorktree(projectPath, specId), diff: null };
	const diff = await git(found.worktree, [
		"diff",
		"--unified=0",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		found.mergeBase,
	]);
	return {
		worktree: found.worktree,
		diff: diff === null ? null : keepDiffSections(diff, isTaskFile),
	};
}
