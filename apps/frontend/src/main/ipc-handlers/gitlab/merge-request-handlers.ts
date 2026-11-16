/**
 * The GitLab merge requests of a project (local, or a server project's
 * through the relay): the list in one of GitLab's states, newest activity
 * first, and a new merge request from the create dialog. Arguments are
 * checked by `ipc-guard.ts` before a handler runs.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type { GitLabMergeRequest } from "../../../shared/types";
import { gitlabIpcMain } from "./ipc-guard";
import { withGitLabProject } from "./project-gitlab";
import type { CreateMergeRequestOptions, GitLabAPIMergeRequest } from "./types";
import { encodeProjectPath, gitlabFetch } from "./utils";

/** The view's merge request from GitLab's, whatever field it left out. */
function transformMergeRequest(apiMr: GitLabAPIMergeRequest): GitLabMergeRequest {
	return {
		id: apiMr.id,
		iid: apiMr.iid,
		title: apiMr.title || "",
		description: apiMr.description || undefined,
		state: apiMr.state || "opened",
		sourceBranch: apiMr.source_branch || "",
		targetBranch: apiMr.target_branch || "",
		author: apiMr.author
			? { username: apiMr.author.username || "", avatarUrl: apiMr.author.avatar_url || undefined }
			: { username: "" },
		assignees: Array.isArray(apiMr.assignees)
			? apiMr.assignees.map((a) => ({ username: a?.username || "", avatarUrl: a?.avatar_url || undefined }))
			: [],
		labels: Array.isArray(apiMr.labels) ? apiMr.labels : [],
		webUrl: apiMr.web_url || "",
		createdAt: apiMr.created_at || new Date().toISOString(),
		updatedAt: apiMr.updated_at || apiMr.created_at || new Date().toISOString(),
		mergedAt: apiMr.merged_at || undefined,
		mergeStatus: apiMr.merge_status || "",
	};
}

/** GitLab's body for a new merge request: the fields the dialog filled in. */
function newMergeRequestBody(options: CreateMergeRequestOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		source_branch: options.sourceBranch,
		target_branch: options.targetBranch,
		title: options.title,
	};
	if (options.description !== undefined) body.description = options.description;
	if (options.labels !== undefined) body.labels = options.labels.join(",");
	if (options.assigneeIds !== undefined) body.assignee_ids = options.assigneeIds;
	if (options.removeSourceBranch !== undefined) body.remove_source_branch = options.removeSourceBranch;
	if (options.squash !== undefined) body.squash = options.squash;
	return body;
}

export function registerMergeRequestHandlers(): void {
	gitlabIpcMain.handle(
		IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS,
		async (_event, projectId: string, state = "opened") =>
			withGitLabProject(projectId, "get merge requests", async (config) => {
				const mrs = (await gitlabFetch(
					config.token,
					config.instanceUrl,
					`/projects/${encodeProjectPath(config.project)}/merge_requests?state=${state}&per_page=100&order_by=updated_at&sort=desc`,
				)) as GitLabAPIMergeRequest[];
				return mrs.map(transformMergeRequest);
			}),
	);

	gitlabIpcMain.handle(
		IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST,
		async (_event, projectId: string, options: CreateMergeRequestOptions) =>
			withGitLabProject(projectId, "create merge request", async (config) => {
				const mr = (await gitlabFetch(
					config.token,
					config.instanceUrl,
					`/projects/${encodeProjectPath(config.project)}/merge_requests`,
					{ method: "POST", body: JSON.stringify(newMergeRequestBody(options)) },
				)) as GitLabAPIMergeRequest;
				return transformMergeRequest(mr);
			}),
	);
}
