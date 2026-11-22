/**
 * The `ipcMain` the Bitbucket handlers register on, as `gitlab/ipc-guard.ts`
 * is for GitLab. What the renderer sends becomes part of a Bitbucket API path
 * or query, so it is checked here, before the handler runs: an issue or pull
 * request id is a positive integer (a list of them bounded), a filter one of
 * a closed list, a page a small positive integer, a pipeline a `{uuid}`. A
 * refused `invoke` rejects.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import {
	type ArgChecks,
	argsAllowed,
	guardedIpcMain,
	isNumber,
	isNumberList,
} from "../github/ipc-arg-guard";
import { isPipelineUuid } from "./utils";

export const ISSUE_FILTERS = ["open", "closed", "all"] as const;
export const PR_STATES = ["OPEN", "MERGED", "DECLINED"] as const;
/** Pages of pipelines a view may ask for. */
export const MAX_PIPELINE_PAGE = 20;
/** At most this many issues are imported in one call. */
export const MAX_IMPORT = 50;

const optionalOf = (values: readonly string[]) => (value: unknown) =>
	value === undefined || values.includes(value as string);
const isPage = (value: unknown) =>
	value === undefined || (isNumber(value) && value <= MAX_PIPELINE_PAGE);

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION]: (args) => args.length === 0,
	[IPC_CHANNELS.BITBUCKET_GET_ISSUES]: ([filter]) => optionalOf(ISSUE_FILTERS)(filter),
	[IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS]: ([id]) => isNumber(id),
	[IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES]: ([ids]) =>
		isNumberList(ids) && ids.length > 0 && ids.length <= MAX_IMPORT,
	[IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS]: ([state]) => optionalOf(PR_STATES)(state),
	[IPC_CHANNELS.BITBUCKET_GET_PR_DIFF]: ([id]) => isNumber(id),
	[IPC_CHANNELS.BITBUCKET_GET_PR_COMMENTS]: ([id]) => isNumber(id),
	[IPC_CHANNELS.BITBUCKET_GET_PIPELINES]: ([page]) => isPage(page),
	[IPC_CHANNELS.BITBUCKET_GET_PIPELINE_STEPS]: ([uuid]) => isPipelineUuid(uuid),
};

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const bitbucketArgsAllowed = (channel: string, args: unknown[]): boolean =>
	typeof args[0] === "string" && argsAllowed(CHECKS, channel, args);

const guarded = guardedIpcMain(CHECKS, "Invalid Bitbucket arguments");

/** `guardedIpcMain`, with the project id also required to be a string. */
export const bitbucketIpcMain = {
	handle(channel: string, listener: Parameters<typeof guarded.handle>[1]): void {
		guarded.handle(channel, (event, ...args) => {
			if (typeof args[0] !== "string") throw new Error("Invalid Bitbucket arguments");
			return listener(event, ...args);
		});
	},
};
