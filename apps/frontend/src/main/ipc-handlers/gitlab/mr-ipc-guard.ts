/**
 * The `ipcMain` the merge request review handlers register on
 * (`mr-review-handlers.ts`), as `github/pr-ipc-guard.ts` is for pull requests.
 * What the renderer sends for a merge request becomes part of a GitLab API
 * path, a request body or a file name (`review_<iid>.json`), so it is checked
 * here, before the handler runs: an MR iid is a positive integer, assignees a
 * list of GitLab user ids, a merge method one of GitLab's three, a note text,
 * the findings to post their ids. A refused `invoke` rejects; a refused
 * `send` is dropped.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import {
	type ArgChecks,
	argsAllowed,
	guardedIpcMain,
	isNumber,
	isNumberList,
	isText,
	MAX_BATCH,
} from "../github/ipc-arg-guard";

const MERGE_METHODS = ["merge", "squash", "rebase"];

/** The findings chosen to post: their ids, as many as a review holds. */
const isFindingIds = (v: unknown): boolean =>
	v === undefined || (Array.isArray(v) && v.length <= MAX_BATCH && v.every(isText));

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.GITLAB_MR_POST_REVIEW]: ([iid, ids]) => isNumber(iid) && isFindingIds(ids),
	[IPC_CHANNELS.GITLAB_MR_POST_NOTE]: ([iid, body]) => isNumber(iid) && isText(body),
	[IPC_CHANNELS.GITLAB_MR_MERGE]: ([iid, method]) =>
		isNumber(iid) && (method === undefined || MERGE_METHODS.includes(method as string)),
	[IPC_CHANNELS.GITLAB_MR_ASSIGN]: ([iid, userIds]) => isNumber(iid) && isNumberList(userIds),
};
for (const channel of [
	IPC_CHANNELS.GITLAB_MR_GET_REVIEW,
	IPC_CHANNELS.GITLAB_MR_REVIEW,
	IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW,
	IPC_CHANNELS.GITLAB_MR_APPROVE,
	IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL,
	IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS,
]) {
	CHECKS[channel] = ([iid]) => isNumber(iid);
}

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const mrArgsAllowed = (channel: string, args: unknown[]): boolean =>
	argsAllowed(CHECKS, channel, args);

export const mrIpcMain = guardedIpcMain(CHECKS, "Invalid merge request arguments");
