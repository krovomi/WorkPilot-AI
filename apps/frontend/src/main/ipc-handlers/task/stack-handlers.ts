/**
 * Stack a task on one of its blockers, and keep it on its parent (F6).
 *
 * `stackOn` writes the metadata that makes B's worktree start from A's
 * branch (`baseBranch`, `useLocalBranch`, `stackParent`, `stackParentSha`,
 * `stackTrunk`); the backend's `detect_base_branch` and `create_worktree` do
 * the rest. `stackUpdate` keeps B on A when A moves (a QA fix, a hand edit):
 * `git rebase --onto <new A> <old A>` in B's worktree, never while an agent
 * runs on B and never on a dirty worktree. Once A is merged, B goes onto A's
 * base the same way (`--onto <base> <old A>`, which works after a squash
 * merge too), and its PR is retargeted (`gh pr edit --base`). A conflict
 * aborts the rebase and lists the files: nothing is resolved for the person.
 *
 * The renderer passes task ids only: every id, branch and commit is checked
 * again here (rule S6), and git and gh get argument lists (rule 6).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, Project, Task } from "../../../shared/types";
import {
	COMMIT_SHA,
	SPEC_ID,
	type StackStatus,
	afterParentMerged,
	branchOf,
	isSafeBranch,
	stackMetadata,
	stackRefusal,
} from "../../../shared/utils/task-stack";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { getToolPath } from "../../cli-tool-manager";
import { projectStore } from "../../project-store";
import { findServerCard } from "../../server-board-actions";
import { findTaskWorktree } from "../../worktree-paths";
import { atomicWriteFileSync } from "./execution-utils";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";
import { getEffectiveBaseBranch } from "./worktree-git-refs";

const TASK_ID_MAX = 300;

export interface StackUpdateResult {
	/** What was done: rebased onto the parent, moved onto the base, or nothing to do. */
	outcome: "rebased" | "moved_to_base" | "metadata_only" | "up_to_date";
	conflicts?: string[];
	/** The PR could not be retargeted: say so, the rebase still happened. */
	prNote?: string;
	/** The metadata patch written (`null` removed a key), for the renderer's store. */
	metadata?: Record<string, unknown>;
}

function refused<T>(code: string, data?: T): IPCResult<T> {
	return data === undefined ? { success: false, error: code } : { success: false, error: code, data };
}

function git(cwd: string, args: string[]): string {
	return execFileSync(getToolPath("git"), args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		timeout: 120_000,
	}).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
}

function commitOf(cwd: string, ref: string): string | null {
	const sha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return sha && COMMIT_SHA.test(sha) ? sha : null;
}

function local(taskId: unknown): { task: Task; project: Project } | string {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) {
		return "task_not_found";
	}
	if (findServerCard(taskId)) return "local_only";
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project?.path) return "task_not_found";
	return { task, project };
}

/** The metadata patch merged into every spec copy; `null` removes a key. */
export function writeMetadata(task: Task, project: Project, patch: Record<string, unknown>): boolean {
	let written = 0;
	for (const dir of allSpecDirs(getSpecPaths(task, project))) {
		const file = path.join(dir, "task_metadata.json");
		try {
			let current: Record<string, unknown> = {};
			if (existsSync(file)) {
				const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>;
				}
			}
			for (const [key, value] of Object.entries(patch)) {
				if (value === null) delete current[key];
				else current[key] = value;
			}
			atomicWriteFileSync(file, JSON.stringify(current, null, 2));
			written += 1;
		} catch (error) {
			appLog.warn(
				`[STACK] Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return written > 0;
}

/** The branch the parent itself goes to (its own stack parent's, or its base). */
function parentBase(parent: Task, project: Project): string {
	const stacked = parent.metadata?.stackParent;
	if (stacked && SPEC_ID.test(stacked)) return branchOf(stacked);
	return getEffectiveBaseBranch(project.path, parent.specId, project.settings?.mainBranch);
}

function findBySpec(project: Project, specId: string): Task | undefined {
	return projectStore.getTasks(project.id).find((t) => t.specId === specId || t.id === specId);
}

export async function stackOn(
	childId: unknown,
	parentId: unknown,
): Promise<IPCResult<Record<string, unknown>>> {
	const child = local(childId);
	if (typeof child === "string") return refused(child);
	const parent = local(parentId);
	if (typeof parent === "string") return refused(parent);
	if (parent.project.id !== child.project.id) return refused("not_blocker");
	const { project } = child;
	const tasks = projectStore.getTasks(project.id);
	const why = stackRefusal(child.task, parent.task, tasks);
	if (why) return refused(why);
	if (!SPEC_ID.test(parent.task.specId)) return refused("parent_no_worktree");
	if (findTaskWorktree(project.path, child.task.specId)) return refused("child_started");
	if (!findTaskWorktree(project.path, parent.task.specId)) return refused("parent_no_worktree");
	const branch = branchOf(parent.task.specId);
	const sha = commitOf(project.path, branch);
	if (!sha) return refused("parent_no_worktree");
	const base = parentBase(parent.task, project);
	if (!isSafeBranch(base)) return refused("parent_no_worktree");
	const ahead = tryGit(project.path, ["rev-list", "--count", `${base}..${branch}`]);
	if (!ahead || Number(ahead) <= 0) return refused("parent_no_commits");
	const trunk = parent.task.metadata?.stackTrunk || base;
	if (!isSafeBranch(trunk)) return refused("parent_no_worktree");
	const patch = stackMetadata(parent.task.specId, sha, trunk);
	if (!writeMetadata(child.task, project, patch)) return refused("metadata_unwritable");
	appLog.info(`[STACK] ${child.task.specId} stacked on ${parent.task.specId} at ${sha.slice(0, 8)}`);
	return { success: true, data: patch };
}

export function stackStatus(childId: unknown, agentManager?: AgentManager): IPCResult<StackStatus> {
	const child = local(childId);
	if (typeof child === "string") return refused(child);
	const { task, project } = child;
	const parentSpec = task.metadata?.stackParent;
	if (!parentSpec || !SPEC_ID.test(parentSpec)) return { success: true, data: { stacked: false } };
	const parent = findBySpec(project, parentSpec);
	const parentBranch = branchOf(parentSpec);
	const recorded = task.metadata?.stackParentSha ?? "";
	const current = commitOf(project.path, parentBranch);
	const merged = parent?.status === "done";
	return {
		success: true,
		data: {
			stacked: true,
			parentTaskId: parent?.id,
			parentTitle: parent?.title,
			parentBranch,
			recordedSha: recorded,
			currentSha: current,
			moved: Boolean(current && COMMIT_SHA.test(recorded) && current !== recorded),
			parentMerged: merged,
			nextBase: parent ? parentBase(parent, project) : task.metadata?.stackTrunk,
			childStarted: Boolean(findTaskWorktree(project.path, task.specId)),
			running: task.status === "in_progress" || Boolean(agentManager?.isRunning(task.specId)),
		},
	};
}

/** Rebase B's worktree `--onto target old`; the files in conflict when it stops. */
function rebaseOnto(worktree: string, target: string, old: string): string[] | null {
	try {
		git(worktree, ["rebase", "--onto", target, old]);
		return null;
	} catch {
		const files = (tryGit(worktree, ["diff", "--name-only", "--diff-filter=U"]) ?? "")
			.split("\n")
			.filter(Boolean)
			.slice(0, 50);
		tryGit(worktree, ["rebase", "--abort"]);
		return files.length > 0 ? files : ["(unknown)"];
	}
}

function retargetPr(task: Task, project: Project, base: string): string | undefined {
	const url = task.metadata?.prUrl;
	if (!url) return undefined;
	if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url)) return "pr_url_unreadable";
	try {
		execFileSync(getToolPath("gh"), ["pr", "edit", url, "--base", base], {
			cwd: project.path,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			timeout: 60_000,
		});
		return undefined;
	} catch (error) {
		appLog.warn(`[STACK] gh pr edit failed: ${error instanceof Error ? error.message.split("\n")[0] : ""}`);
		return "pr_not_retargeted";
	}
}

export async function stackUpdate(
	childId: unknown,
	agentManager?: AgentManager,
): Promise<IPCResult<StackUpdateResult>> {
	const status = stackStatus(childId, agentManager);
	if (!status.success || !status.data) return refused(status.error ?? "task_not_found");
	const state = status.data;
	if (!state.stacked) return refused("not_stacked");
	if (state.running) return refused("running");
	const child = local(childId);
	if (typeof child === "string") return refused(child);
	const { task, project } = child;
	const old = state.recordedSha ?? "";
	if (!COMMIT_SHA.test(old)) return refused("no_recorded_commit");
	const worktree = findTaskWorktree(project.path, task.specId);
	if (worktree && tryGit(worktree, ["status", "--porcelain"]) !== "") return refused("dirty");

	if (state.parentMerged) {
		const base = state.nextBase ?? "";
		if (!isSafeBranch(base)) return refused("no_base");
		// A task branch is newest locally; a trunk is newest on the remote.
		let onto = commitOf(project.path, base);
		if (!base.startsWith("workpilot/")) {
			tryGit(project.path, ["fetch", "--quiet", "origin", base]);
			onto = commitOf(project.path, `origin/${base}`) ?? onto;
		}
		if (!onto) return refused("no_base");
		if (worktree) {
			const conflicts = rebaseOnto(worktree, onto, old);
			if (conflicts) return refused("conflict", { outcome: "up_to_date", conflicts });
		}
		const trunk = task.metadata?.stackTrunk || base;
		const patch = afterParentMerged(base, onto, trunk);
		writeMetadata(task, project, patch);
		const prNote = retargetPr(task, project, base);
		appLog.info(`[STACK] ${task.specId} moved onto ${base}`);
		return { success: true, data: { outcome: "moved_to_base", prNote, metadata: patch } };
	}

	const current = state.currentSha ?? "";
	if (!state.moved || !COMMIT_SHA.test(current)) {
		return { success: true, data: { outcome: "up_to_date" } };
	}
	if (worktree) {
		const conflicts = rebaseOnto(worktree, current, old);
		if (conflicts) return refused("conflict", { outcome: "up_to_date", conflicts });
	}
	const patch = { stackParentSha: current };
	writeMetadata(task, project, patch);
	appLog.info(`[STACK] ${task.specId} rebased onto ${current.slice(0, 8)}`);
	return { success: true, data: { outcome: worktree ? "rebased" : "metadata_only", metadata: patch } };
}

export function registerStackHandlers(agentManager?: AgentManager): void {
	ipcMain.handle(IPC_CHANNELS.TASK_STACK_ON, (_, childId: unknown, parentId: unknown) =>
		stackOn(childId, parentId),
	);
	ipcMain.handle(IPC_CHANNELS.TASK_STACK_STATUS, (_, childId: unknown) =>
		stackStatus(childId, agentManager),
	);
	ipcMain.handle(IPC_CHANNELS.TASK_STACK_UPDATE, (_, childId: unknown) =>
		stackUpdate(childId, agentManager),
	);
}
