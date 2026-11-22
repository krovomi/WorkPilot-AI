/**
 * After a merge, the other green cards take the new base and their suite
 * runs again (lot F of `docs/architecture/test-placement-ci.md`).
 *
 * A green card is one QA approved, waiting for review or for its pull
 * request. Its worktree merges the base it was built on (local branch, or
 * `origin/<base>` when the remote is ahead, as after a pull request merged on
 * the forge); a conflict is aborted and recorded, nothing else is touched.
 * Then, as Leub chose: the branch is pushed to the forge's CI when the
 * project's CI is followed (no model call), else the QA review runs again
 * here, its old approval removed. A worktree with uncommitted changes is
 * left alone.
 */

import { readFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";
import { GIT_BRANCH_REGEX } from "../ipc-handlers/task/worktree-git-refs";
import { getPlanPath, updatePlanFile } from "../ipc-handlers/task/plan-file-utils";
import { findTaskWorktree } from "../worktree-paths";
import { approvedSignoffAt, defaultGitRun, type GitRun, pushTaskBranch } from "./ci-suite";

const GIT_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 120_000;

type PlanJson = Record<string, unknown>;

export type RefreshOutcome =
	| "up_to_date"
	| "dirty"
	| "conflict"
	| "ci"
	| "qa"
	| "skipped";

/** What `plan.baseRefresh` holds after a look. */
export interface BaseRefreshRecord {
	state: "merged" | "conflict";
	base: string;
	at: string;
	sha?: string;
	rerun?: "ci" | "qa";
}

export interface BaseRefreshDeps {
	/** The project's CI is followed (provider known, route not set aside). */
	ciFollowed: (project: Project) => boolean;
	/** Run the QA review of the card again on this machine. */
	rerunQa: (task: Task, project: Project) => Promise<boolean>;
	baseOf: (project: Project, task: Task) => string;
	git?: GitRun;
	now?: () => Date;
}

function readPlan(planPath: string): PlanJson | null {
	try {
		return JSON.parse(readFileSync(planPath, "utf-8")) as PlanJson;
	} catch {
		return null;
	}
}

/** The cards that may need the new base: approved, in review, not the one merged. */
export function greenCards(tasks: readonly Task[], mergedTaskId: string | null): Task[] {
	return tasks.filter(
		(task) =>
			task.id !== mergedTaskId &&
			(task.status === "human_review" || task.status === "pr_created") &&
			task.qaSignoff?.status === "approved" &&
			!task.metadata?.archivedAt &&
			!task.metadata?.prMergedAt &&
			!task.stagedInMainProject,
	);
}

async function ok(git: GitRun, cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<boolean> {
	try {
		await git(cwd, args, timeout);
		return true;
	} catch {
		return false;
	}
}

/**
 * The ref to merge: `origin/<base>` when it contains the local branch (the
 * forge moved on), else the local branch (a merge made in the app).
 */
export async function baseRef(git: GitRun, worktree: string, base: string): Promise<string> {
	await ok(git, worktree, ["fetch", "origin", base]);
	const remote = `refs/remotes/origin/${base}`;
	const hasRemote = await ok(git, worktree, ["rev-parse", "--verify", "--quiet", remote]);
	if (!hasRemote) return base;
	const hasLocal = await ok(git, worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]);
	if (!hasLocal) return `origin/${base}`;
	return (await ok(git, worktree, ["merge-base", "--is-ancestor", base, `origin/${base}`]))
		? `origin/${base}`
		: base;
}

async function record(planPath: string, patch: Record<string, unknown>): Promise<void> {
	await updatePlanFile<PlanJson>(planPath, (plan) => Object.assign(plan, patch));
}

/** One green card brought onto the new base, then its suite started again. */
export async function refreshCard(
	project: Project,
	task: Task,
	deps: BaseRefreshDeps,
): Promise<RefreshOutcome> {
	const git = deps.git ?? defaultGitRun;
	const worktree = findTaskWorktree(project.path, task.specId);
	if (!worktree) return "skipped";
	const base = deps.baseOf(project, task);
	if (!base || !GIT_BRANCH_REGEX.test(base) || base.includes("..")) return "skipped";

	const ref = await baseRef(git, worktree, base);
	if (await ok(git, worktree, ["merge-base", "--is-ancestor", ref, "HEAD"])) return "up_to_date";
	let status: string;
	try {
		status = await git(worktree, ["status", "--porcelain"], GIT_TIMEOUT_MS);
	} catch {
		return "skipped";
	}
	if (status.trim()) return "dirty";

	const planPath = getPlanPath(project, task);
	const at = (deps.now?.() ?? new Date()).toISOString();
	if (!(await ok(git, worktree, ["merge", "--no-edit", ref], MERGE_TIMEOUT_MS))) {
		await ok(git, worktree, ["merge", "--abort"]);
		const conflict: BaseRefreshRecord = { state: "conflict", base: ref, at };
		await record(planPath, { baseRefresh: conflict });
		console.warn(`[BaseRefresh] ${task.specId}: ${ref} conflicts with the task branch; left as it was`);
		return "conflict";
	}

	if (deps.ciFollowed(project)) {
		const pushed = await pushTaskBranch(worktree, git);
		if (pushed.ok) {
			const signoffAt = approvedSignoffAt(readPlan(planPath)) ?? undefined;
			const merged: BaseRefreshRecord = { state: "merged", base: ref, at, sha: pushed.sha, rerun: "ci" };
			await record(planPath, {
				baseRefresh: merged,
				ciSuite: { state: "pending", branch: pushed.branch, sha: pushed.sha, pushedAt: at, signoffAt },
			});
			return "ci";
		}
		console.warn(`[BaseRefresh] ${task.specId}: push failed (${pushed.reason}); QA runs here`);
	}
	// The approval was given on the old base: QA runs again only without it
	// (`qa.criteria.should_run_qa`), and the card leaves the green ones.
	const merged: BaseRefreshRecord = { state: "merged", base: ref, at, rerun: "qa" };
	await updatePlanFile<PlanJson>(planPath, (plan) => {
		plan.baseRefresh = merged;
		delete plan.qa_signoff;
		return plan;
	});
	return (await deps.rerunQa(task, project)) ? "qa" : "skipped";
}

/** Every green card of the project, one after another. */
export async function refreshGreenCards(
	project: Project,
	tasks: readonly Task[],
	mergedTaskId: string | null,
	deps: BaseRefreshDeps,
): Promise<Record<string, RefreshOutcome>> {
	const outcomes: Record<string, RefreshOutcome> = {};
	for (const task of greenCards(tasks, mergedTaskId)) {
		try {
			outcomes[task.specId] = await refreshCard(project, task, deps);
		} catch (error) {
			console.warn(`[BaseRefresh] ${task.specId}: not refreshed:`, error);
			outcomes[task.specId] = "skipped";
		}
	}
	return outcomes;
}
