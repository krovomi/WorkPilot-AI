/**
 * Preventive merge check (#358, lot 2). Two specs of one wave that share
 * files under the tolerance are test-merged: `git merge-tree --write-tree`
 * merges the commits of their two worktrees in the object store only. No
 * worktree, index, branch or ref is touched; the trees it writes are
 * unreachable objects git collects as usual. A real textual conflict puts the
 * pair in different waves, and the view says which files conflicted.
 *
 * Bounded: at most `MAX_MERGE_CHECKS` pairs and `MERGE_CHECK_BUDGET_MS` per
 * plan, each git call under its own timeout. Git by argument list, no shell;
 * the commits passed to git are object ids checked here, never a name a
 * branch could be called. Committed work only: what a worktree has not
 * committed yet is not part of the test merge (its files still count in the
 * score).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WaveMergeChecks } from "../../shared/types/conflict-waves";
import { getToolPath } from "../cli-tool-manager";
import { findTaskWorktree } from "../worktree-paths";
import { MAX_LISTED_FILES, type MergeOutcome, type PlannerResult, pairKey } from "./planner";

const execFileAsync = promisify(execFile);

export const MAX_MERGE_CHECKS = 24;
export const MERGE_CHECK_BUDGET_MS = 20_000;
const MERGE_CHECK_TIMEOUT_MS = 8_000;
const HEAD_TIMEOUT_MS = 5_000;
/** SHA-1 or SHA-256 object id, as `git rev-parse` prints it. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface MergeCheckDeps {
	/** Commit a task's worktree is on, or null when it has none. */
	worktreeHead: (projectPath: string, specId: string) => Promise<string | null>;
	/** Test merge of two commits, or null when git cannot say. */
	testMerge: (
		projectPath: string,
		a: string,
		b: string,
		timeoutMs: number,
	) => Promise<MergeOutcome | null>;
	/** Milliseconds, for the time budget. */
	clock?: () => number;
}

export async function readWorktreeHead(
	projectPath: string,
	specId: string,
): Promise<string | null> {
	const worktree = findTaskWorktree(projectPath, specId);
	if (!worktree) return null;
	try {
		const { stdout } = await execFileAsync(
			getToolPath("git"),
			["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
			{ cwd: worktree, timeout: HEAD_TIMEOUT_MS, encoding: "utf-8" },
		);
		// Checked again, as an object id, before it reaches `merge-tree`.
		return stdout.trim();
	} catch {
		return null;
	}
}

/** `<tree id>\0<file>\0<file>\0…`: what `--name-only -z` prints on a conflict. */
function conflictedFiles(stdout: string): string[] | null {
	const [tree, ...files] = stdout.split("\0");
	if (!OBJECT_ID.test(tree)) return null;
	return [...new Set(files.filter(Boolean))].slice(0, MAX_LISTED_FILES);
}

export async function gitTestMerge(
	projectPath: string,
	a: string,
	b: string,
	timeoutMs: number,
): Promise<MergeOutcome | null> {
	if (!OBJECT_ID.test(a) || !OBJECT_ID.test(b)) return null;
	try {
		await execFileAsync(
			getToolPath("git"),
			["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b],
			{ cwd: projectPath, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf-8" },
		);
		return { verdict: "clean", files: [] };
	} catch (error) {
		// Exit 1 with a tree id first is a conflict; anything else (no common
		// history, a git without `--write-tree`, a timeout) is no answer.
		const { code, stdout } = error as { code?: unknown; stdout?: unknown };
		const files = code === 1 && typeof stdout === "string" ? conflictedFiles(stdout) : null;
		return files ? { verdict: "conflict", files } : null;
	}
}

/**
 * Pairs of one wave worth a test merge: both specs have a worktree and they
 * share files under the tolerance. Riskiest first (the planner sorts pairs).
 */
function pendingPairs(
	result: PlannerResult,
	worktreeTasks: ReadonlyMap<string, string>,
	attempted: ReadonlySet<string>,
): Array<{ a: string; b: string; key: string }> {
	const waveOf = new Map<string, number>();
	for (const wave of result.waves) for (const id of wave.taskIds) waveOf.set(id, wave.index);
	return result.pairs
		.filter(
			(p) =>
				!p.blocking &&
				p.score > 0 &&
				worktreeTasks.has(p.a) &&
				worktreeTasks.has(p.b) &&
				waveOf.get(p.a) === waveOf.get(p.b),
		)
		.map((p) => ({ a: p.a, b: p.b, key: pairKey(p.a, p.b) }))
		.filter((p) => !attempted.has(p.key));
}

/**
 * Plans, test-merges the pairs the plan put together, and plans again each
 * time one conflicts, until no pair is left to check or a limit is reached.
 * `worktreeTasks` maps a task id to its spec id, for tasks with a worktree.
 */
export async function planWithMergeChecks(
	plan: (checks: ReadonlyMap<string, MergeOutcome>) => PlannerResult,
	projectPath: string,
	worktreeTasks: ReadonlyMap<string, string>,
	deps: MergeCheckDeps,
): Promise<{ result: PlannerResult; mergeChecks: WaveMergeChecks }> {
	const clock = deps.clock ?? Date.now;
	const deadline = clock() + MERGE_CHECK_BUDGET_MS;
	const checks = new Map<string, MergeOutcome>();
	const attempted = new Set<string>();
	const heads = new Map<string, Promise<string | null>>();
	const headOf = (taskId: string): Promise<string | null> => {
		let head = heads.get(taskId);
		if (!head) {
			head = deps.worktreeHead(projectPath, worktreeTasks.get(taskId) as string);
			heads.set(taskId, head);
		}
		return head;
	};

	let failed = 0;
	let result = plan(checks);
	let plannedWith = 0;
	let split = true;
	while (split) {
		split = false;
		for (const pair of pendingPairs(result, worktreeTasks, attempted)) {
			const remaining = deadline - clock();
			if (attempted.size >= MAX_MERGE_CHECKS || remaining <= 0) break;
			attempted.add(pair.key);
			const [headA, headB] = await Promise.all([headOf(pair.a), headOf(pair.b)]);
			const outcome =
				headA && headB
					? await deps.testMerge(
							projectPath,
							headA,
							headB,
							Math.min(MERGE_CHECK_TIMEOUT_MS, remaining),
						)
					: null;
			if (!outcome) {
				failed++;
				continue;
			}
			checks.set(pair.key, outcome);
			if (outcome.verdict === "conflict") {
				// Plan again before checking more: the waves are about to change.
				split = true;
				break;
			}
		}
		if (split) {
			result = plan(checks);
			plannedWith = checks.size;
		}
	}
	// Clean verdicts add no edge: the waves stay, the pairs show the verdict.
	if (checks.size !== plannedWith) result = plan(checks);

	const conflicts = [...checks.values()].filter((c) => c.verdict === "conflict").length;
	return {
		result,
		mergeChecks: {
			checked: checks.size,
			conflicts,
			unchecked: pendingPairs(result, worktreeTasks, attempted).length,
			failed,
		},
	};
}
