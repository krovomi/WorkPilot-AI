/**
 * The bulk import of GitLab issues as tasks: a local project's issue becomes
 * a spec in its folder, with the screenshots pasted into it; a server
 * project's becomes a card of its shared board. One issue that fails does not
 * stop the others. The iids are checked by `ipc-guard.ts` before the handler
 * runs.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	GitLabImportResult,
	IPCResult,
	Task,
} from "../../../shared/types";
import { createServerCard } from "../../server-board-actions";
import { featureProject } from "../server-feature-files";
import { attachGitLabIssueImages } from "../shared/issue-attachments";
import {
	buildIssueContext,
	createSpecForIssue,
	type GitLabTaskInfo,
	gitlabSpecDir,
} from "./spec-utils";
import { gitlabIpcMain } from "./ipc-guard";
import type { GitLabAPIIssue } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch } from "./utils";

// What a server card takes (`shared_board/api.py`).
const SERVER_TITLE_MAX = 200;
const SERVER_DESCRIPTION_MAX = 20_000;

/**
 * Import multiple GitLab issues as tasks
 */
export function registerImportIssues(): void {
	gitlabIpcMain.handle(
		IPC_CHANNELS.GITLAB_IMPORT_ISSUES,
		async (
			_event,
			projectId: string,
			issueIids: number[],
		): Promise<IPCResult<GitLabImportResult>> => {

			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}

			const config = await getGitLabConfig(project);
			if (!config) {
				return {
					success: false,
					error: "GitLab not configured",
				};
			}

			const tasks: GitLabTaskInfo[] = [];
			const cards: Task[] = [];
			const errors: string[] = [];
			let imported = 0;
			let failed = 0;

			for (const iid of issueIids) {
				try {
					const encodedProject = encodeProjectPath(config.project);

					// Fetch the issue
					const apiIssue = (await gitlabFetch(
						config.token,
						config.instanceUrl,
						`/projects/${encodedProject}/issues/${iid}`,
					)) as GitLabAPIIssue;

					// A server project's issue becomes a card of its shared board; the
					// server writes the spec and its agents run there.
					if (project.remote) {
						const card = await createServerCard(
							project,
							String(apiIssue.title ?? "").slice(0, SERVER_TITLE_MAX),
							buildIssueContext(
								apiIssue,
								config.project,
								config.instanceUrl,
							).slice(0, SERVER_DESCRIPTION_MAX),
						);
						if (!card.success || !card.data) {
							throw new Error(card.error ?? "Server unavailable");
						}
						cards.push(card.data);
						imported++;
						continue;
					}

					// Create a spec/task from the issue
					const task = await createSpecForIssue(
						project,
						apiIssue,
						config,
						project.settings?.mainBranch,
					);

					if (task) {
						// The screenshots pasted into the issue, for the
						// attachments preflight.
						await attachGitLabIssueImages(
							config.token,
							config.instanceUrl,
							config.project,
							apiIssue.description,
							apiIssue.iid,
							gitlabSpecDir(project, task.specId),
						);
						tasks.push(task);
						imported++;
					} else {
						failed++;
						errors.push(`Failed to create task for issue #${iid}`);
					}
				} catch (error) {
					failed++;
					const errorMessage =
						error instanceof Error
							? error.message
							: `Unknown error for issue #${iid}`;
					errors.push(errorMessage);
				}
			}

			// Note: IPCResult.success indicates transport success (IPC call completed without system error).
			// data.success indicates operation success (at least one issue was imported).
			// This distinction allows the UI to differentiate between system failures and partial imports.
			return {
				success: true,
				data: {
					success: imported > 0,
					imported,
					failed,
					errors: errors.length > 0 ? errors : undefined,
					...(project.remote ? { tasks: cards } : {}),
				},
			};
		},
	);
}

export function registerImportHandlers(): void {
	registerImportIssues();
}
