/**
 * The investigation of a GitLab issue: the issue and the notes the person
 * chose become a task (`spec-utils.ts`), with the screenshots pasted into the
 * issue, and the view hears progress, result and failure. A local project
 * only: the task is written in its folder. Arguments are checked by
 * `ipc-guard.ts` before the handler runs.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { GitLabInvestigationResult, GitLabInvestigationStatus } from "../../../shared/types";
import { projectStore } from "../../project-store";
import { attachGitLabIssueImages } from "../shared/issue-attachments";
import { gitlabIpcMain } from "./ipc-guard";
import { userNotes } from "./issue-handlers";
import { createSpecForIssue, gitlabSpecDir } from "./spec-utils";
import type { GitLabAPIIssue, GitLabAPINote } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch } from "./utils";

export function registerInvestigationHandlers(getMainWindow: () => BrowserWindow | null): void {
	const send = (channel: string, projectId: string, payload: unknown) =>
		getMainWindow()?.webContents.send(channel, projectId, payload);
	const progress = (projectId: string, status: GitLabInvestigationStatus) =>
		send(IPC_CHANNELS.GITLAB_INVESTIGATION_PROGRESS, projectId, status);
	const fail = (projectId: string, error: string) =>
		send(IPC_CHANNELS.GITLAB_INVESTIGATION_ERROR, projectId, error);

	gitlabIpcMain.on(
		IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE,
		async (_event, projectId: string, issueIid: number, selectedNoteIds: number[] = []) => {
			const project = projectStore.getProject(projectId);
			if (!project) return fail(projectId, "Project not found");
			const config = await getGitLabConfig(project);
			if (!config) return fail(project.id, "GitLab not configured");

			try {
				progress(project.id, { phase: "fetching", issueIid, progress: 10, message: "Fetching issue details..." });
				const issue = (await gitlabFetch(
					config.token,
					config.instanceUrl,
					`/projects/${encodeProjectPath(config.project)}/issues/${issueIid}`,
				)) as GitLabAPIIssue;
				const notes: GitLabAPINote[] =
					selectedNoteIds.length > 0
						? (await userNotes(config, issueIid)).filter((note) => selectedNoteIds.includes(note.id))
						: [];

				progress(project.id, { phase: "creating_task", issueIid, progress: 60, message: "Creating task from issue..." });
				const task = await createSpecForIssue(project, issue, config, project.settings?.mainBranch, notes);
				if (!task) return fail(project.id, "Failed to create task from issue");

				await attachGitLabIssueImages(
					config.token,
					config.instanceUrl,
					config.project,
					issue.description,
					issue.iid,
					gitlabSpecDir(project, task.specId),
				);

				progress(project.id, { phase: "complete", issueIid, progress: 100, message: "Investigation complete" });
				const result: GitLabInvestigationResult = {
					success: true,
					issueIid,
					analysis: {
						summary: `Investigation of GitLab issue #${issueIid}: ${issue.title}`,
						proposedSolution: issue.description || "See task details for more information.",
						affectedFiles: [],
						estimatedComplexity: "standard",
						acceptanceCriteria: [],
					},
					taskId: task.id,
				};
				send(IPC_CHANNELS.GITLAB_INVESTIGATION_COMPLETE, project.id, result);
			} catch (error) {
				fail(project.id, error instanceof Error ? error.message : "Investigation failed");
			}
		},
	);
}
