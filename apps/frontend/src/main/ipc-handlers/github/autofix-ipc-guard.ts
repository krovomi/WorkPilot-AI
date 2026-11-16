/**
 * The `ipcMain` the auto-fix handlers register on (`autofix-handlers.ts`).
 * What the renderer sends for an auto-fix becomes part of a GitHub API path,
 * a file name, the runner's arguments or the project's `config.json`, so it
 * is checked here, before the handler runs: an issue number (or a list of
 * them) is a positive integer, the configuration has the shape the app writes,
 * and an approved batch names its issues by number. A refused `invoke`
 * rejects; a refused `send` is dropped.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import { type ArgChecks, argsAllowed, guardedIpcMain, isNumber, isNumberList, isText, MAX_BATCH } from "./ipc-arg-guard";

/** GitHub caps a label name at 50 characters. */
const MAX_LABEL = 50;
const MAX_LABELS = 100;
/** Longer than any model id or thinking level the app offers. */
const MAX_SETTING = 200;
const MAX_BATCHES = 100;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isSetting = (value: unknown) => isText(value) && value.length > 0 && value.length <= MAX_SETTING;
const isLabel = (value: unknown) => isText(value) && value.length > 0 && value.length <= MAX_LABEL;

const isConfig = (config: unknown) =>
	isObject(config) &&
	typeof config.enabled === "boolean" &&
	typeof config.requireHumanApproval === "boolean" &&
	Array.isArray(config.labels) &&
	config.labels.length <= MAX_LABELS &&
	config.labels.every(isLabel) &&
	isSetting(config.model) &&
	isSetting(config.thinkingLevel);

const isBatchIssue = (issue: unknown) => isObject(issue) && isNumber(issue.issueNumber) && isText(issue.title);
const isBatch = (batch: unknown) =>
	isObject(batch) &&
	isNumber(batch.primaryIssue) &&
	Array.isArray(batch.issues) &&
	batch.issues.length <= MAX_BATCH &&
	batch.issues.every(isBatchIssue);

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG]: ([config]) => isConfig(config),
	[IPC_CHANNELS.GITHUB_AUTOFIX_START]: ([issueNumber]) => isNumber(issueNumber),
	[IPC_CHANNELS.GITHUB_AUTOFIX_BATCH]: ([issueNumbers]) => issueNumbers === undefined || isNumberList(issueNumbers),
	[IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW]: ([issueNumbers, maxIssues]) =>
		(issueNumbers === undefined || isNumberList(issueNumbers)) && (maxIssues === undefined || isNumber(maxIssues)),
	[IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES]: ([batches]) =>
		Array.isArray(batches) && batches.length <= MAX_BATCHES && batches.every(isBatch),
};

/** Whether the arguments a channel received (project id first) may reach its handler. */
export const autofixArgsAllowed = (channel: string, args: unknown[]): boolean => argsAllowed(CHECKS, channel, args);

export const autofixIpcMain = guardedIpcMain(CHECKS, "Invalid auto-fix arguments");
