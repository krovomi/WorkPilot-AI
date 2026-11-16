/**
 * The `ipcMain` the pull request handlers register on (`pr-handlers.ts`).
 * What the renderer sends for a pull request becomes part of a GitHub API
 * path, a request body or a file name, so it is checked here, before the
 * handler runs: a PR number (or a list of them) is a positive integer, a
 * workflow run id too, a merge method one of GitHub's three, an assignee a
 * GitHub login, a comment and a cursor text. A refused `invoke` rejects; a
 * refused `send` is dropped.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import { type ArgChecks, argsAllowed, guardedIpcMain, isNumber, isNumberList, isText } from "./ipc-arg-guard";

const MERGE_METHODS = ["merge", "squash", "rebase"];
/** A GitHub login: letters, digits and dashes, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.GITHUB_PR_LIST_MORE]: ([cursor]) => isText(cursor),
	[IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH]: ([numbers]) => isNumberList(numbers),
	[IPC_CHANNELS.GITHUB_PR_POST_COMMENT]: ([prNumber, body]) => isNumber(prNumber) && isText(body),
	[IPC_CHANNELS.GITHUB_PR_MERGE]: ([prNumber, method]) =>
		isNumber(prNumber) && (method === undefined || MERGE_METHODS.includes(method as string)),
	[IPC_CHANNELS.GITHUB_PR_ASSIGN]: ([prNumber, login]) =>
		isNumber(prNumber) && isText(login) && GITHUB_LOGIN.test(login),
	[IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE]: ([runId]) => isNumber(runId),
};
for (const channel of [
	IPC_CHANNELS.GITHUB_PR_GET,
	IPC_CHANNELS.GITHUB_PR_GET_DIFF,
	IPC_CHANNELS.GITHUB_PR_GET_REVIEW,
	IPC_CHANNELS.GITHUB_PR_GET_LOGS,
	IPC_CHANNELS.GITHUB_PR_REVIEW,
	IPC_CHANNELS.GITHUB_PR_POST_REVIEW,
	IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED,
	IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW,
	IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL,
	IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
	IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
	IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH,
	IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW,
	IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL,
]) {
	CHECKS[channel] = ([prNumber]) => isNumber(prNumber);
}

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const prArgsAllowed = (channel: string, args: unknown[]): boolean => argsAllowed(CHECKS, channel, args);

export const prIpcMain = guardedIpcMain(CHECKS, "Invalid pull request arguments");
