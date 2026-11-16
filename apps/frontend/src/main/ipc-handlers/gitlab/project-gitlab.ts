/**
 * What the GitLab views read or write with a project's GitLab config: the
 * project (local, or a server project's through the relay, `featureProject`),
 * its config, and the answer as an `IPCResult` that says why it failed.
 */

import type { IPCResult } from "../../../shared/types";
import { featureProject } from "../server-feature-files";
import type { GitLabConfig } from "./types";
import { getGitLabConfig } from "./utils";

/**
 * Runs `call` with the project's GitLab config; a failed result when the
 * project is unknown, has no GitLab config, or `call` throws (its message,
 * else `Failed to <what>`).
 */
export async function withGitLabProject<T>(
	projectId: string,
	what: string,
	call: (config: GitLabConfig) => Promise<T>,
): Promise<IPCResult<T>> {
	const project = featureProject(projectId);
	if (!project) return { success: false, error: "Project not found" };
	const config = await getGitLabConfig(project);
	if (!config) return { success: false, error: "GitLab not configured" };
	try {
		return { success: true, data: await call(config) };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : `Failed to ${what}` };
	}
}
