/**
 * The `ipcMain` the Azure DevOps handlers (`azure-devops-handlers.ts`)
 * register on, as `github/ipc-arg-guard.ts` does for the forges. What the
 * renderer sends after the project id reaches the backend runner as a value
 * (a work item id, the types to list) or names a task of the project, so it is
 * checked before the handler runs: work item ids are positive integers, a list
 * of them is bounded, types are short texts, a task id is a bounded text, and
 * the import options carry only their one flag. A refused `invoke` rejects.
 */

import { IPC_CHANNELS } from "../../shared/constants";
import { type ArgChecks, argsAllowed, guardedIpcMain, isNumber, isNumberList, isText } from "./github/ipc-arg-guard";

/** More work items than one list asks Azure DevOps for. */
const MAX_ITEMS = 1000;
/** Azure DevOps caps a work item type or a project name at 128 characters, a task id is a spec folder. */
const MAX_NAME = 255;

const isName = (value: unknown) => isText(value) && value.length > 0 && value.length <= MAX_NAME;
const optional = (check: (value: unknown) => boolean) => (value: unknown) => value === undefined || check(value);
const isTypes = (value: unknown) => Array.isArray(value) && value.length <= MAX_NAME && value.every(isName);
const isImportOptions = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.entries(value).every(([key, flag]) => key === "requireReviewBeforeCoding" && typeof flag === "boolean");
const nothing = (args: unknown[]) => args.length === 0;

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION]: nothing,
	[IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOSITORIES]: nothing,
	[IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPOSITORY]: nothing,
	[IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS]: ([azureProject, itemTypes, maxItems, ...rest]) =>
		rest.length === 0 &&
		optional(isName)(azureProject) &&
		optional(isTypes)(itemTypes) &&
		optional((n) => isNumber(n) && n <= MAX_ITEMS)(maxItems),
	[IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM]: ([workItemId, ...rest]) => rest.length === 0 && isNumber(workItemId),
	[IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS]: ([workItemIds, options, ...rest]) =>
		rest.length === 0 && isNumberList(workItemIds) && optional(isImportOptions)(options),
	[IPC_CHANNELS.AZURE_DEVOPS_HYDRATE_TASK_DISPLAY]: ([taskId, ...rest]) => rest.length === 0 && isName(taskId),
	[IPC_CHANNELS.AZURE_DEVOPS_SYNC_TASK_AC]: ([taskId, workItemId, ...rest]) =>
		rest.length === 0 && isName(taskId) && isNumber(workItemId),
};

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const azureDevOpsArgsAllowed = (channel: string, args: unknown[]): boolean =>
	argsAllowed(CHECKS, channel, args);

export const azureDevOpsIpcMain = guardedIpcMain(CHECKS, "Invalid Azure DevOps arguments");
