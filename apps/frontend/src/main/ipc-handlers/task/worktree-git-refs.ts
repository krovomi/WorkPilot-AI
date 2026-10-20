/**
 * Branch names and refs: validating a worktree branch, finding the base branch a
 * task diffs against, and resolving the refs a diff compares. Split out of
 * worktree-handlers.ts (audit lot L11, F36).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getToolPath } from "../../cli-tool-manager";

// Regex pattern for validating git branch names
export const GIT_BRANCH_REGEX =
	/^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

/**
 * Validates a detected branch name and returns the safe branch to delete.
 *
 * Why `workpilot/` prefix is considered safe:
 * - All task worktrees use branches named `workpilot/{specId}`
 * - This pattern is controlled by WorkPilot AI, not user input
 * - If detected branch matches this pattern, it's a valid task branch
 * - If it doesn't match (e.g., `main`, `develop`, `feature/xxx`), it's likely
 *   the main project's branch being incorrectly detected from a corrupted worktree
 *
 * Issue #1479: When cleaning up a corrupted worktree, git rev-parse walks up
 * to the main project and returns its current branch instead of the worktree's branch.
 * This could cause deletion of the wrong branch.
 */
export function validateWorktreeBranch(
	detectedBranch: string | null,
	expectedBranch: string,
): { branchToDelete: string; usedFallback: boolean; reason: string } {
	// If detection failed, use expected pattern
	if (detectedBranch === null) {
		return {
			branchToDelete: expectedBranch,
			usedFallback: true,
			reason: "detection_failed",
		};
	}

	// Exact match - ideal case
	if (detectedBranch === expectedBranch) {
		return {
			branchToDelete: detectedBranch,
			usedFallback: false,
			reason: "exact_match",
		};
	}

	// Matches workpilot pattern with valid specId (not just "workpilot/"))
	// The specId must be non-empty for this to be a valid task branch
	if (
		detectedBranch.startsWith("workpilot/") &&
		detectedBranch.length > "workpilot/".length
	) {
		return {
			branchToDelete: detectedBranch,
			usedFallback: false,
			reason: "pattern_match",
		};
	}

	// Detected branch doesn't match expected pattern - use fallback
	// This is the critical security fix for issue #1479
	return {
		branchToDelete: expectedBranch,
		usedFallback: true,
		reason: "invalid_pattern",
	};
}

/**
 * Read the stored base branch from task_metadata.json
 * This is the branch the task was created from (set by user during task creation)
 */
export function getTaskBaseBranch(specDir: string): string | undefined {
	// Defensive check for undefined input
	if (!specDir || typeof specDir !== "string") {
		console.error("[getTaskBaseBranch] specDir is undefined or not a string");
		return undefined;
	}

	try {
		const metadataPath = path.join(specDir, "task_metadata.json");
		if (existsSync(metadataPath)) {
			const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
			// Return baseBranch if explicitly set (not the __project_default__ marker)
			// Also validate it's a valid branch name to prevent malformed git commands
			if (
				metadata.baseBranch &&
				metadata.baseBranch !== "__project_default__" &&
				GIT_BRANCH_REGEX.test(metadata.baseBranch)
			) {
				return metadata.baseBranch;
			}
		}
	} catch (e) {
		console.warn("[getTaskBaseBranch] Failed to read task metadata:", e);
	}
	return undefined;
}

/**
 * Get the effective base branch for a task with proper fallback chain.
 * Priority:
 * 1. Task metadata baseBranch (explicit task-level override from task_metadata.json)
 * 2. Project settings mainBranch (project-level default)
 * 3. Git default branch detection (main/master)
 * 4. Fallback to 'main'
 *
 * This should be used instead of getting the current HEAD branch,
 * as the user may be on a feature branch when viewing worktree status.
 */
export function getEffectiveBaseBranch(
	projectPath: string,
	specId: string,
	projectMainBranch?: string,
): string {
	// Defensive check for undefined inputs
	if (!projectPath || typeof projectPath !== "string") {
		console.error(
			"[getEffectiveBaseBranch] projectPath is undefined or not a string",
		);
		return "main";
	}
	if (!specId || typeof specId !== "string") {
		console.error(
			"[getEffectiveBaseBranch] specId is undefined or not a string",
		);
		return "main";
	}

	// 1. Try task metadata baseBranch
	const specDir = path.join(projectPath, ".workpilot", "specs", specId);
	const taskBaseBranch = getTaskBaseBranch(specDir);
	if (taskBaseBranch) {
		return taskBaseBranch;
	}

	// 2. Try project settings mainBranch
	if (projectMainBranch && GIT_BRANCH_REGEX.test(projectMainBranch)) {
		return projectMainBranch;
	}

	// 3-5. Ask git itself. Works from any git directory, worktrees included.
	return detectGitDefaultBranch(projectPath);
}

/**
 * Detect a repository's default branch from git alone, for callers that have a
 * git directory but no project/spec context (e.g. a worktree path).
 *
 * Never assume a hardcoded branch name: WorkPilot's own repo uses `develop`,
 * but most projects use `main` or `master`, and some use `trunk`/`production`.
 * Running `git checkout <wrong-branch> --` either fails outright or, worse,
 * restores files from an unrelated branch that happens to exist.
 */
export function detectGitDefaultBranch(cwd: string): string {
	// 1. Ask the remote what its default branch is. This is the source of
	// truth for repos that don't use 'main' or 'master' (e.g. 'develop',
	// 'trunk', 'production'). Without this the count of files / commits in
	// the "Build ready for review" panel comes back as 0 against a branch
	// that doesn't exist locally.
	try {
		const symref = execFileSync(
			getToolPath("git"),
			["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
			{
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		).trim();
		// Output is "origin/<branch>" — strip the remote prefix.
		const detected = symref.startsWith("origin/")
			? symref.slice("origin/".length)
			: symref;
		if (detected && GIT_BRANCH_REGEX.test(detected)) {
			return detected;
		}
	} catch {
		// symbolic-ref fails when origin/HEAD isn't set locally — fall through
		// to the per-branch heuristic below.
	}

	// 2. Try to detect the usual default branches. 'develop' is included so
	// GitFlow repos without an explicit project mainBranch still resolve.
	for (const branch of ["main", "master", "develop"]) {
		try {
			execFileSync(getToolPath("git"), ["rev-parse", "--verify", branch], {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			return branch;
		} catch {
			// Branch doesn't exist, try next
		}
	}

	// 3. Last-resort fallback.
	return "main";
}

/**
 * Vérifie qu'une ref git existe dans le worktree donné.
 * Utilisé pour basculer sur `origin/<branch>` quand la branche distante
 * existe (cas d'une PR pushée), afin que le compteur de fichiers/diff
 * reflète l'état réellement publié plutôt que l'état local divergent.
 */
export function gitRefExists(cwd: string, ref: string): boolean {
	try {
		execFileSync(getToolPath("git"), ["rev-parse", "--verify", ref], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Résultat de la résolution des refs à utiliser pour calculer le diff
 * d'un worktree.
 */
export interface ResolvedDiffRefs {
	/** Ref de la base (ex: `origin/develop` ou `develop`). */
	baseRef: string;
	/** Ref de la HEAD effective (ex: `origin/feature/x` ou `HEAD`). */
	headRef: string;
	/** True si on est tombé sur une ref distante pour la HEAD. */
	usingRemoteHead: boolean;
}

/**
 * Détermine les refs à utiliser pour `git diff` dans un worktree :
 * - HEAD distante (`origin/<branch>`) prioritaire si elle existe ; sinon HEAD.
 * - Base distante (`origin/<baseBranch>`) prioritaire si elle existe ; sinon base locale.
 *
 * Cela permet à l'UI WorkPilot de refléter l'état tel qu'il apparaît dans la PR
 * (origin), même si le worktree local a divergé après un push depuis ailleurs,
 * un reset ou un rebase.
 */
export function resolveDiffRefs(
	worktreePath: string,
	branch: string,
	baseBranch: string,
): ResolvedDiffRefs {
	const remoteHead = `origin/${branch}`;
	const remoteBase = `origin/${baseBranch}`;
	const usingRemoteHead = gitRefExists(worktreePath, remoteHead);
	const headRef = usingRemoteHead ? remoteHead : "HEAD";
	const baseRef = gitRefExists(worktreePath, remoteBase)
		? remoteBase
		: baseBranch;
	return { baseRef, headRef, usingRemoteHead };
}
