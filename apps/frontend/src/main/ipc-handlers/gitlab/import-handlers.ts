/**
 * GitLab import handlers
 * Handles bulk importing issues as tasks
 */

import { ipcMain } from "electron";
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
import type { GitLabAPIIssue } from "./types";
import { encodeProjectPath, getGitLabConfig, gitlabFetch } from "./utils";

// What a server card takes (`shared_board/api.py`).
const SERVER_TITLE_MAX = 200;
const SERVER_DESCRIPTION_MAX = 20_000;

// Debug logging helper
const DEBUG =
	process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

function debugLog(_message: string, data?: unknown): void {
	if (DEBUG) {
		if (data !== undefined) {
			/* intentionally empty */
		} else {
			// noop
		}
	}
}

/**
 * Import multiple GitLab issues as tasks
 */
export function registerImportIssues(): void {
	ipcMain.handle(
		IPC_CHANNELS.GITLAB_IMPORT_ISSUES,
		async (
			_event,
			projectId: string,
			issueIids: number[],
		): Promise<IPCResult<GitLabImportResult>> => {
			debugLog("importGitLabIssues handler called", { issueIids });

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

			for (const iid of Array.isArray(issueIids) ? issueIids : []) {
				try {
					// From the renderer: a number, before it is put in a URL
					if (!Number.isInteger(iid) || iid <= 0) {
						throw new Error("Invalid issue number");
					}
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
						debugLog("Imported issue:", { iid, taskId: task.id });
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
					debugLog("Failed to import issue:", { iid, error: errorMessage });
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

/**
 * Register all import handlers
 */
export function registerImportHandlers(): void {
	debugLog("Registering GitLab import handlers");
	registerImportIssues();
	debugLog("GitLab import handlers registered");
}
