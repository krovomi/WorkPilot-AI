/**
 * The GitLab issues of a project (local, or a server project's through the
 * relay): the list, newest activity first, and an issue's notes without
 * GitLab's own system notes. Arguments are checked by `ipc-guard.ts` before
 * a handler runs.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type { GitLabIssue, GitLabNote } from "../../../shared/types";
import { gitlabIpcMain } from "./ipc-guard";
import { withGitLabProject } from "./project-gitlab";
import type { GitLabAPIIssue, GitLabAPINote, GitLabConfig } from "./types";
import { encodeProjectPath, gitlabFetch } from "./utils";

/** The view's issue from GitLab's; a milestone in a state the view does not know shows as active. */
function transformIssue(apiIssue: GitLabAPIIssue, projectPath: string): GitLabIssue {
	const milestone = apiIssue.milestone && {
		id: apiIssue.milestone.id,
		title: apiIssue.milestone.title,
		state: apiIssue.milestone.state === "closed" ? ("closed" as const) : ("active" as const),
	};
	return {
		id: apiIssue.id,
		iid: apiIssue.iid,
		title: apiIssue.title,
		description: apiIssue.description,
		state: apiIssue.state,
		labels: apiIssue.labels ?? [],
		assignees: (apiIssue.assignees ?? []).map((a) => ({
			username: a?.username ?? "unknown",
			avatarUrl: a?.avatar_url,
		})),
		author: {
			username: apiIssue.author?.username ?? "unknown",
			avatarUrl: apiIssue.author?.avatar_url,
		},
		milestone,
		createdAt: apiIssue.created_at,
		updatedAt: apiIssue.updated_at,
		closedAt: apiIssue.closed_at,
		userNotesCount: apiIssue.user_notes_count,
		webUrl: apiIssue.web_url,
		projectPathWithNamespace: projectPath,
	};
}

function transformNote(apiNote: GitLabAPINote): GitLabNote {
	return {
		id: apiNote.id,
		body: apiNote.body,
		author: {
			username: apiNote.author?.username ?? "unknown",
			avatarUrl: apiNote.author?.avatar_url,
		},
		createdAt: apiNote.created_at,
		updatedAt: apiNote.updated_at,
		system: apiNote.system,
	};
}

/** An issue's notes, oldest first, without GitLab's system notes. */
export async function userNotes(
	config: GitLabConfig,
	issueIid: number,
): Promise<GitLabAPINote[]> {
	const notes = (await gitlabFetch(
		config.token,
		config.instanceUrl,
		`/projects/${encodeProjectPath(config.project)}/issues/${issueIid}/notes?per_page=100&order_by=created_at&sort=asc`,
	)) as GitLabAPINote[];
	return notes.filter((note) => !note.system);
}

export function registerIssueHandlers(): void {
	gitlabIpcMain.handle(
		IPC_CHANNELS.GITLAB_GET_ISSUES,
		async (_event, projectId: string, state: "opened" | "closed" | "all" = "opened") =>
			withGitLabProject(projectId, "get issues", async (config) => {
				const issues = (await gitlabFetch(
					config.token,
					config.instanceUrl,
					`/projects/${encodeProjectPath(config.project)}/issues?state=${state}&per_page=100&order_by=updated_at&sort=desc`,
				)) as GitLabAPIIssue[];
				return issues.map((issue) => transformIssue(issue, config.project));
			}),
	);

	gitlabIpcMain.handle(
		IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES,
		async (_event, projectId: string, issueIid: number) =>
			withGitLabProject(projectId, "get notes", async (config) =>
				(await userNotes(config, issueIid)).map(transformNote),
			),
	);
}
