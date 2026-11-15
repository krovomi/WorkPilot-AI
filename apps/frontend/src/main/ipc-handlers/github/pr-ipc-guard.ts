/**
 * The `ipcMain` the pull request handlers register on (`pr-handlers.ts`).
 * What the renderer sends for a pull request becomes part of a GitHub API
 * path, a request body or a file name, so it is checked here, before the
 * handler runs: a PR number (or a list of them) is a positive integer, a
 * workflow run id too, a merge method one of GitHub's three, an assignee a
 * GitHub login, a comment and a cursor text. A refused `invoke` rejects; a
 * refused `send` is dropped.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";

type HandleListener = Parameters<typeof ipcMain.handle>[1];
type OnListener = Parameters<typeof ipcMain.on>[1];

const MERGE_METHODS = ["merge", "squash", "rebase"];
/** A GitHub login: letters, digits and dashes, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** More reviews than a list ever shows at once. */
const MAX_BATCH = 500;

const isNumber = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown) => typeof value === "string";

/** Each channel's check of the arguments after the project id. */
const CHECKS: Record<string, (args: unknown[]) => boolean> = {
	[IPC_CHANNELS.GITHUB_PR_LIST_MORE]: ([cursor]) => isText(cursor),
	[IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH]: ([numbers]) =>
		Array.isArray(numbers) && numbers.length <= MAX_BATCH && numbers.every(isNumber),
	[IPC_CHANNELS.GITHUB_PR_POST_COMMENT]: ([prNumber, body]) => isNumber(prNumber) && isText(body),
	[IPC_CHANNELS.GITHUB_PR_MERGE]: ([prNumber, method]) =>
		isNumber(prNumber) && (method === undefined || MERGE_METHODS.includes(method as string)),
	[IPC_CHANNELS.GITHUB_PR_ASSIGN]: ([prNumber, login]) =>
		isNumber(prNumber) && isText(login) && GITHUB_LOGIN.test(login as string),
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
export function prArgsAllowed(channel: string, args: unknown[]): boolean {
	const check = CHECKS[channel];
	return !check || check(args.slice(1));
}

export const prIpcMain = {
	handle(channel: string, listener: HandleListener): void {
		ipcMain.handle(channel, (event, ...args) => {
			if (!prArgsAllowed(channel, args)) {
				throw new Error("Invalid pull request arguments");
			}
			return listener(event, ...args);
		});
	},
	on(channel: string, listener: OnListener): void {
		ipcMain.on(channel, (event, ...args) => {
			if (prArgsAllowed(channel, args)) listener(event, ...args);
		});
	},
};
