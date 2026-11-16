/**
 * Whether a project reaches its GitLab project: its path, description and
 * open issue count, or why not. A failure is an answer (`connected: false`),
 * not an error, so the view can say it.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { GitLabSyncStatus, IPCResult } from "../../../shared/types";
import { featureProject } from "../server-feature-files";
import type { GitLabAPIProject } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch, gitlabFetchWithCount } from "./utils";

export function registerRepositoryHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_CHECK_CONNECTION,
		async (_event, projectId: string): Promise<IPCResult<GitLabSyncStatus>> => {
			const project = featureProject(projectId);
			if (!project) return { success: false, error: "Project not found" };

			const config = await getGitLabConfig(project);
			if (!config) {
				return {
					success: true,
					data: {
						connected: false,
						error: "GitLab not configured. Please add GITLAB_TOKEN and GITLAB_PROJECT to your .env file.",
					},
				};
			}

			try {
				const path = `/projects/${encodeProjectPath(config.project)}`;
				const info = (await gitlabFetch(config.token, config.instanceUrl, path)) as GitLabAPIProject;
				const { totalCount: issueCount } = await gitlabFetchWithCount(
					config.token,
					config.instanceUrl,
					`${path}/issues?state=opened&per_page=1`,
				);
				return {
					success: true,
					data: {
						connected: true,
						instanceUrl: config.instanceUrl,
						projectPathWithNamespace: info.path_with_namespace,
						projectDescription: info.description,
						issueCount,
						lastSyncedAt: new Date().toISOString(),
					},
				};
			} catch (error) {
				return {
					success: true,
					data: {
						connected: false,
						error: error instanceof Error ? error.message : "Failed to connect to GitLab",
					},
				};
			}
		},
	);
}
