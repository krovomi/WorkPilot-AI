/**
 * The `ipcMain` the terminal and Claude profile handlers
 * (`terminal-handlers.ts`) and the terminal worktree handlers
 * (`worktree-handlers.ts`) register on: each argument the renderer sends is
 * checked before the handler runs, as `github/ipc-arg-guard.ts` does for the
 * forges. These channels take no project id first, so the checks read every
 * argument. Ids, names and paths are bounded text, sizes positive integers, a
 * date a day; a new terminal takes from the renderer no environment but a
 * profile's `CLAUDE_CONFIG_DIR` under the home folder, and auto-switch
 * settings only their own fields. A refused `invoke` rejects; a refused
 * `send` is dropped.
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import { isValidConfigDir } from "../../utils/config-path-validator";
import { type ArgChecks, argsAllowed, guardedIpcMain, isText, MAX_BATCH } from "../github/ipc-arg-guard";

/** A terminal id, a profile id, a provider name. */
const MAX_ID = 200;
/** A title, a profile name, a folder. */
const MAX_NAME = 4096;
/** What one write to a terminal carries: a paste, at most. */
const MAX_INPUT = 1_000_000;
/** An OAuth token or an email typed in the settings. */
const MAX_TOKEN = 10_000;
/** More columns or rows than any screen shows. */
const MAX_SIZE = 10_000;

const isId = (value: unknown) => isText(value) && value.length > 0 && value.length <= MAX_ID;
const isName = (value: unknown) => isText(value) && value.length <= MAX_NAME;
const isSize = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_SIZE;
const isBoolean = (value: unknown) => typeof value === "boolean";
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (check: (value: unknown) => boolean) => (value: unknown) => value === undefined || check(value);
const isDay = (value: unknown) => isText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** An object whose keys are all known and whose values pass their check. */
const isShaped = (fields: Record<string, (value: unknown) => boolean>) => (value: unknown) =>
	isObject(value) &&
	Object.keys(value).every((key) => key in fields) &&
	Object.entries(fields).every(([key, check]) => check(value[key]));

/** The one variable a terminal may take from the renderer: a profile's folder. */
const isTerminalEnv = (value: unknown) =>
	isObject(value) &&
	Object.entries(value).every(
		([key, dir]) => key === "CLAUDE_CONFIG_DIR" && isName(dir) && isValidConfigDir(dir as string),
	);

const isCreateOptions = isShaped({
	id: isId,
	cwd: optional(isName),
	cols: optional(isSize),
	rows: optional(isSize),
	projectPath: optional(isName),
	skipOAuthToken: optional(isBoolean),
	env: optional(isTerminalEnv),
});

/** A profile as the settings send it back: its id (none, or empty, when new), a name, a folder. */
const isProfile = (value: unknown) =>
	isObject(value) &&
	(value.id === undefined || value.id === "" || isId(value.id)) &&
	isName(value.name) &&
	(value.name as string).trim().length > 0 &&
	optional(isName)(value.configDir) &&
	optional(isBoolean)(value.isDefault);

const isPercent = (value: unknown) => typeof value === "number" && value >= 0 && value <= 100;
const isAutoSwitch = isShaped({
	enabled: optional(isBoolean),
	proactiveSwapEnabled: optional(isBoolean),
	usageCheckInterval: optional((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0),
	sessionThreshold: optional(isPercent),
	weeklyThreshold: optional(isPercent),
	autoSwitchOnRateLimit: optional(isBoolean),
	autoSwitchOnAuthFailure: optional(isBoolean),
	sameProviderFirst: optional(isBoolean),
});

const isRetry = isShaped({
	source: isName,
	projectId: isId,
	taskId: optional(isId),
	profileId: isId,
});

const isWorktreeConfig = (value: unknown) => value === undefined || value === null || isObject(value);
const isSession = (value: unknown) => isObject(value) && isId(value.id);
const isOrders = (value: unknown) =>
	Array.isArray(value) &&
	value.length <= MAX_BATCH &&
	value.every(
		(order) =>
			isObject(order) &&
			isId(order.terminalId) &&
			typeof order.displayOrder === "number" &&
			Number.isSafeInteger(order.displayOrder) &&
			order.displayOrder >= 0,
	);

const isWorktreeRequest = isShaped({
	terminalId: isId,
	name: isId,
	taskId: optional(isId),
	createGitBranch: isBoolean,
	projectPath: isName,
	baseBranch: optional(isName),
	useLocalBranch: optional(isBoolean),
});

const CHECKS: ArgChecks = {
	[IPC_CHANNELS.TERMINAL_CREATE]: ([options]) => isCreateOptions(options),
	[IPC_CHANNELS.TERMINAL_DESTROY]: ([id]) => isId(id),
	[IPC_CHANNELS.TERMINAL_INPUT]: ([id, data]) => isId(id) && isText(data) && data.length <= MAX_INPUT,
	[IPC_CHANNELS.TERMINAL_RESIZE]: ([id, cols, rows]) => isId(id) && isSize(cols) && isSize(rows),
	[IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE]: ([id, cwd]) => isId(id) && optional(isName)(cwd),
	[IPC_CHANNELS.TERMINAL_GENERATE_NAME]: ([command, cwd]) =>
		isText(command) && command.length <= MAX_INPUT && optional(isName)(cwd),
	[IPC_CHANNELS.TERMINAL_SET_TITLE]: ([id, title]) => isId(id) && isName(title),
	[IPC_CHANNELS.TERMINAL_SET_WORKTREE_CONFIG]: ([id, config]) => isId(id) && isWorktreeConfig(config),
	[IPC_CHANNELS.CLAUDE_PROFILE_SAVE]: ([profile]) => isProfile(profile),
	[IPC_CHANNELS.CLAUDE_PROFILE_DELETE]: ([profileId]) => isId(profileId),
	[IPC_CHANNELS.CLAUDE_PROFILE_RENAME]: ([profileId, name]) => isId(profileId) && isName(name),
	[IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE]: ([profileId]) => isId(profileId),
	[IPC_CHANNELS.CLAUDE_PROFILE_SWITCH]: ([terminalId, profileId]) => isId(terminalId) && isId(profileId),
	[IPC_CHANNELS.CLAUDE_PROFILE_SET_TOKEN]: ([profileId, token, email]) =>
		isId(profileId) &&
		isText(token) &&
		token.trim().length > 0 &&
		token.length <= MAX_TOKEN &&
		optional((v) => isText(v) && v.length <= MAX_TOKEN)(email),
	[IPC_CHANNELS.CLAUDE_PROFILE_UPDATE_AUTO_SWITCH]: ([settings]) => isAutoSwitch(settings),
	[IPC_CHANNELS.ACCOUNT_PRIORITY_SET]: ([order]) =>
		Array.isArray(order) && order.length <= MAX_BATCH && order.every(isId),
	[IPC_CHANNELS.CLAUDE_RETRY_WITH_PROFILE]: ([request]) => isRetry(request),
	[IPC_CHANNELS.USAGE_REQUEST]: ([provider]) => optional(isId)(provider),
	[IPC_CHANNELS.ALL_PROFILES_USAGE_REQUEST]: ([force]) => optional(isBoolean)(force),
	[IPC_CHANNELS.TERMINAL_GET_SESSIONS]: ([projectPath]) => isName(projectPath),
	[IPC_CHANNELS.TERMINAL_RESTORE_SESSION]: ([session, cols, rows]) =>
		isSession(session) && optional(isSize)(cols) && optional(isSize)(rows),
	[IPC_CHANNELS.TERMINAL_ACTIVATE_DEFERRED_RESUME]: ([id]) => isId(id),
	[IPC_CHANNELS.TERMINAL_GET_SESSION_DATES]: ([projectPath]) => optional(isName)(projectPath),
	[IPC_CHANNELS.TERMINAL_GET_SESSIONS_FOR_DATE]: ([date, projectPath]) => isDay(date) && isName(projectPath),
	[IPC_CHANNELS.TERMINAL_RESTORE_FROM_DATE]: ([date, projectPath, cols, rows]) =>
		isDay(date) && isName(projectPath) && optional(isSize)(cols) && optional(isSize)(rows),
	[IPC_CHANNELS.TERMINAL_CHECK_PTY_ALIVE]: ([id]) => isId(id),
	[IPC_CHANNELS.TERMINAL_UPDATE_DISPLAY_ORDERS]: ([projectPath, orders]) => isName(projectPath) && isOrders(orders),
	[IPC_CHANNELS.TERMINAL_WORKTREE_CREATE]: ([request]) => isWorktreeRequest(request),
	[IPC_CHANNELS.TERMINAL_WORKTREE_LIST]: ([projectPath]) => isName(projectPath),
	[IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER]: ([projectPath]) => isName(projectPath),
	[IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE]: ([projectPath, name, deleteBranch]) =>
		isName(projectPath) && isId(name) && optional(isBoolean)(deleteBranch),
};

export const terminalIpcMain = guardedIpcMain(CHECKS, "Invalid terminal arguments", 0);

/** Whether `args` (every argument after the event) may reach the handler of `channel`. */
export function terminalArgsAllowed(channel: string, args: unknown[]): boolean {
	return argsAllowed(CHECKS, channel, args, 0);
}
