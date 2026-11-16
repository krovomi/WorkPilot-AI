/**
 * Registers every GitLab IPC handler: sign-in with glab, the connection
 * check, issues and their notes, the investigation that turns an issue into
 * a task, the bulk import, merge requests, and the AI review of a merge
 * request.
 */

import type { BrowserWindow } from "electron";
import { registerImportHandlers } from "./import-handlers";
import { registerInvestigationHandlers } from "./investigation-handlers";
import { registerIssueHandlers } from "./issue-handlers";
import { registerMergeRequestHandlers } from "./merge-request-handlers";
import { registerMRReviewHandlers } from "./mr-review-handlers";
import { registerGitlabOAuthHandlers } from "./oauth-handlers";
import { registerRepositoryHandlers } from "./repository-handlers";

export function registerGitlabHandlers(getMainWindow: () => BrowserWindow | null): void {
	registerGitlabOAuthHandlers();
	registerRepositoryHandlers();
	registerIssueHandlers();
	registerInvestigationHandlers(getMainWindow);
	registerImportHandlers();
	registerMergeRequestHandlers();
	registerMRReviewHandlers(getMainWindow);
}
