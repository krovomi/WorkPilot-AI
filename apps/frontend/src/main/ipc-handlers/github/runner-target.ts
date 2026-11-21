import type { Project } from "../../../shared/types";
import { isGitHubFullName } from "../../../shared/utils/git-remote-repo";
import { isServerHandle } from "./server-relay";
import { getGitHubConfig } from "./utils";

/**
 * The token and repository a GitHub runner (PR review, autofix, triage)
 * works with for this project. The runner reads `GITHUB_TOKEN` before
 * anything else, and `getRunnerEnv` sets it to the account `gh` is logged in
 * with — the same one for every project — so a project's own token and
 * repository are passed explicitly: the token in the env, the repository as
 * `--repo` (the runner otherwise asks `gh repo view`, which may answer with
 * an upstream remote). A server project's handle never becomes a token.
 */
export function githubRunnerTarget(project: Project): {
	env: Record<string, string>;
	repo?: string;
} {
	const config = getGitHubConfig(project);
	if (!config || isServerHandle(config.token) || !isGitHubFullName(config.repo)) {
		return { env: {} };
	}
	return {
		env: { GITHUB_TOKEN: config.token, GITHUB_REPO: config.repo },
		repo: config.repo,
	};
}

