/**
 * The `ipcMain` the GitLab issue, merge request list, import and
 * investigation handlers register on, as `mr-ipc-guard.ts` is for the review
 * of a merge request. What the renderer sends becomes part of a GitLab API
 * path or query, or a request body, so it is checked here, before the handler
 * runs: an issue iid (or a list of them) and a note id are positive integers,
 * a state one of GitLab's, and a new merge request has the fields the dialog
 * sends, of their types. A refused `invoke` rejects; a refused `send` is
 * dropped.
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

const ISSUE_STATES = ["opened", "closed", "all"];
const MR_STATES = ["opened", "closed", "merged", "locked", "all"];
/** GitLab caps a title and a branch name at 255 characters. */
const MAX_NAME = 255;
/** GitLab caps a description at 1 MB; a dialog sends far less. */
const MAX_DESCRIPTION = 1_000_000;

const isState = (states: string[]) => (value: unknown) =>
	value === undefined || states.includes(value as string);
const isName = (value: unknown) => isText(value) && value.trim().length > 0 && value.length <= MAX_NAME;
const isOptional = (check: (value: unknown) => boolean) => (value: unknown) =>
	value === undefined || check(value);
const isBoolean = (value: unknown) => typeof value === "boolean";
const isLabels = (value: unknown) =>
	Array.isArray(value) && value.length <= MAX_BATCH && value.every(isName);

/** Each field a new merge request may carry, and its check. */
const MR_FIELDS: Record<string, (value: unknown) => boolean> = {
	title: isName,
	sourceBranch: isName,
	targetBranch: isName,
	description: isOptional((v) => isText(v) && v.length <= MAX_DESCRIPTION),
	labels: isOptional(isLabels),
	assigneeIds: isOptional(isNumberList),
	removeSourceBranch: isOptional(isBoolean),
	squash: isOptional(isBoolean),
};

const isNewMergeRequest = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const options = value as Record<string, unknown>;
	return (
		Object.keys(options).every((key) => key in MR_FIELDS) &&
		Object.entries(MR_FIELDS).every(([key, check]) => check(options[key]))
	);
};

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.GITLAB_GET_ISSUES]: ([state]) => isState(ISSUE_STATES)(state),
	[IPC_CHANNELS.GITLAB_GET_ISSUE_NOTES]: ([iid]) => isNumber(iid),
	[IPC_CHANNELS.GITLAB_INVESTIGATE_ISSUE]: ([iid, noteIds]) =>
		isNumber(iid) && (noteIds === undefined || isNumberList(noteIds)),
	[IPC_CHANNELS.GITLAB_IMPORT_ISSUES]: ([iids]) => isNumberList(iids),
	[IPC_CHANNELS.GITLAB_GET_MERGE_REQUESTS]: ([state]) => isState(MR_STATES)(state),
	[IPC_CHANNELS.GITLAB_CREATE_MERGE_REQUEST]: ([options]) => isNewMergeRequest(options),
};

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const gitlabArgsAllowed = (channel: string, args: unknown[]): boolean =>
	argsAllowed(CHECKS, channel, args);

export const gitlabIpcMain = guardedIpcMain(CHECKS, "Invalid GitLab arguments");
