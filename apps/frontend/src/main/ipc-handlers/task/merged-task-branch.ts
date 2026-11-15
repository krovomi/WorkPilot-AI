import { execFileSync } from "node:child_process";
import { getIsolatedGitEnv } from "../../utils/git-isolation";

/**
 * Whether a task's work already sits on its base branch: the task branch
 * (`workpilot/<specId>`) is an ancestor of `baseBranch` and its worktree
 * holds nothing uncommitted.
 *
 * That is the state a local "Merge to <base>" leaves: the card stays in
 * Human Review until the user moves it to Done, and there is nothing left to
 * open a pull request for. Moving it to Done used to start a PR anyway, which
 * failed ("no commit to push") and kept the card out of Done for good.
 *
 * Any doubt (unknown branch, git error) answers false, so the PR path keeps
 * its say.
 */
export function taskWorkAlreadyMerged(
	git: string,
	projectPath: string,
	worktreePath: string,
	specId: string,
	baseBranch: string,
): boolean {
	const run = (cwd: string, args: string[]) =>
		execFileSync(git, args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			env: getIsolatedGitEnv(),
		});
	try {
		run(projectPath, ["merge-base", "--is-ancestor", `workpilot/${specId}`, baseBranch]);
		return run(worktreePath, ["status", "--porcelain"]).trim() === "";
	} catch {
		return false;
	}
}
