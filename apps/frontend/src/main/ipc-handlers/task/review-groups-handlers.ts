/**
 * The guided review (`TASK_REVIEW_GROUPS`): a task's diff grouped by the
 * plan's subtasks, then the commits no subtask recorded, then what is not
 * committed (`docs/architecture/guided-review.md`).
 *
 * The renderer passes a task id and nothing else: the worktree, the spec
 * directory and every git ref are resolved here (rules S4, S6). Git runs
 * without a shell, with an argument list. Every decision is made by the pure
 * module `shared/utils/review-groups.ts`; this file only reads.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { AUTO_BUILD_PATHS, IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { ReviewGroups } from "../../../shared/types/review-groups";
import { isBuildOutputPath } from "../../../shared/utils/build-output-paths";
import {
	type BranchCommit,
	type DiffedRange,
	buildCommitRecords,
	finalizeGroups,
	latestQaNotes,
	planRanges,
	planSubtasks,
} from "../../../shared/utils/review-groups";
import { getToolPath } from "../../cli-tool-manager";
import { findServerCard } from "../../server-board-actions";
import { findTaskWorktree } from "../../worktree-paths";
import { getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";
import { collectRangeFiles, collectUncommittedFiles } from "./worktree-diff-files";
import { isWorkpilotArtifact } from "./worktree-diff-handlers";
import { getEffectiveBaseBranch, resolveDiffRefs } from "./worktree-git-refs";

const TASK_ID_MAX = 300;
/** A branch longer than this is shown by its last commits only. */
const MAX_COMMITS = 400;
const HASH = /^[0-9a-f]{7,64}$/;

type Result = IPCResult<ReviewGroups>;

function hidden(p: string): boolean {
	return isWorkpilotArtifact(p) || isBuildOutputPath(p);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return null; // absent or being rewritten: the other copy, or nothing
	}
}

/** The first copy that has the file: the worktree's is the build's own. */
function firstJson(dirs: (string | null)[], relative: string): unknown {
	for (const dir of dirs) {
		if (!dir) continue;
		const data = readJson(path.join(dir, relative));
		if (data) return data;
	}
	return null;
}

function git(cwd: string, args: string[]): string {
	return execFileSync(getToolPath("git"), args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/** The branch's first-parent commits since the merge-base, oldest first. */
function branchCommits(worktree: string, mergeBase: string): BranchCommit[] {
	const out = git(worktree, [
		"log",
		"--first-parent",
		"--reverse",
		"--format=%H%x00%s",
		`${mergeBase}..HEAD`,
	]);
	const commits = out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, subject = ""] = line.split("\0");
			return { hash, subject };
		})
		.filter((c) => HASH.test(c.hash));
	return commits.slice(-MAX_COMMITS);
}

export async function reviewGroups(taskId: unknown): Promise<Result> {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) {
		return { success: false, error: "task_not_found" };
	}
	// A server card's worktree lives on the server: the flat diff stays its review.
	if (findServerCard(taskId)) return { success: false, error: "local_only" };
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return { success: false, error: "task_not_found" };
	const worktree = findTaskWorktree(project.path, task.specId);
	if (!worktree) return { success: false, error: "no_worktree" };

	try {
		const specPaths = getSpecPaths(task, project);
		const dirs = [specPaths.worktreeSpecDir, specPaths.mainSpecDir, specPaths.specDir];
		const plan = firstJson(dirs, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
		const records = buildCommitRecords(
			firstJson(dirs, path.join("memory", "build_commits.json")),
		);

		const baseBranch = getEffectiveBaseBranch(
			project.path,
			task.specId,
			project.settings?.mainBranch,
		);
		// The local HEAD: the commits the build recorded are local ones.
		const { baseRef } = resolveDiffRefs(worktree, "HEAD", baseBranch);
		const mergeBase = git(worktree, ["merge-base", baseRef, "HEAD"]).trim();
		if (!HASH.test(mergeBase)) return { success: false, error: "no_merge_base" };
		const commits = branchCommits(worktree, mergeBase);
		const start = commits.length > 0 && commits.length === MAX_COMMITS
			? git(worktree, ["rev-parse", `${commits[0].hash}^`]).trim()
			: mergeBase;
		const { ranges, approximate } = planRanges(start, commits, records);

		const diffed: DiffedRange[] = ranges.map((range) => ({
			range,
			files: collectRangeFiles(getToolPath("git"), worktree, range.from, range.to, hidden),
		}));
		diffed.push({ files: collectUncommittedFiles(getToolPath("git"), worktree, hidden) });

		return {
			success: true,
			data: finalizeGroups(diffed, planSubtasks(plan), latestQaNotes(plan), approximate),
		};
	} catch (error) {
		// A git failure is an error, never an empty review ("nothing changed").
		console.error("[TASK_REVIEW_GROUPS] could not group the diff:", error);
		return { success: false, error: "git_failed" };
	}
}

export function registerReviewGroupsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TASK_REVIEW_GROUPS, (_, taskId: unknown) => reviewGroups(taskId));
}
