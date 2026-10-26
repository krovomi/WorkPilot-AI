/**
 * The directory arguments of IPC handlers are checked before the handler runs.
 *
 * A handler that receives a project, a worktree or a spec folder from the
 * renderer runs git, reads files or starts a process there. The renderer is
 * not trusted (security.md, S6), so `installIpcPathPolicy` wraps
 * `ipcMain.handle` and `ipcMain.on`: an argument listed in `DIRECTORY_ARGS`,
 * or a `projectPath` / `projectDir` key of an object argument, must resolve
 * to a directory inside a registered project or a folder the user picked in
 * a dialog. Otherwise the handler never runs.
 *
 * The handler still receives the value as sent: several key their state by
 * the project path string, so the check does not rewrite it.
 *
 * `ipc-path-policy.test.ts` reads every handler's parameters and fails when
 * one named like a directory (`projectPath`, `projectDir`, `worktreePath`,
 * `specDir`…) is missing here: a new handler is covered by adding its line.
 */

import type { IpcMain } from "electron";
import { resolveInProject } from "./renderer-path";

/** Channel → positions (after the event) of its directory arguments. */
export const DIRECTORY_ARGS: Readonly<Record<string, readonly number[]>> = {
	"agentDecision:clearLog": [0],
	"agentDecision:getLog": [0],
	"apiExplorer:probeLiveSpec": [0],
	"apiExplorer:scanRoutes": [0],
	"architectureVisualizer:delta": [0],
	"architectureVisualizer:doctor": [0],
	"browserAgent:captureScreenshot": [0],
	"browserAgent:compare": [0],
	"browserAgent:deleteBaseline": [0],
	"browserAgent:getDashboard": [0],
	"browserAgent:listBaselines": [0],
	"browserAgent:navigate": [0],
	"browserAgent:runTests": [0],
	"browserAgent:setBaseline": [0],
	"changelog:readLocalImage": [0],
	"cicdTriggers:cancelRun": [0],
	"cicdTriggers:getConfig": [0],
	"cicdTriggers:getRunStatus": [0],
	"cicdTriggers:listRuns": [0],
	"cicdTriggers:setConfig": [0],
	"cicdTriggers:trigger": [0],
	"contextMesh:registerProject": [0],
	"contextMesh:unregisterProject": [0],
	"costs:getBudget": [0],
	"costs:getContextUsage": [0],
	"costs:getSummary": [0],
	"costs:setBudget": [0],
	"crossLangTranslation:clearHistory": [0],
	"crossLangTranslation:getHistory": [0],
	"dashboard:getSnapshot": [0],
	"dictation:start": [2],
	"fileExplorer:list": [0],
	"fileExplorer:save": [0],
	"fileExplorer:search": [0],
	"git:checkStatus": [0],
	"git:checkoutBranch": [0],
	"git:detectMainBranch": [0],
	"git:detectProvider": [0],
	"git:getBranches": [0],
	"git:getBranchesWithInfo": [0],
	"git:getCurrentBranch": [0],
	"git:initialize": [0],
	"git:setRemote": [0],
	"github:addRemote": [0],
	"github:detectRepo": [0],
	"gitlab:addRemote": [0],
	"gitlab:detectProject": [0],
	"learningLoop:deletePattern": [0],
	"learningLoop:getPatterns": [0],
	"learningLoop:getSummary": [0],
	"learningLoop:runAnalysis": [0],
	"learningLoop:togglePattern": [0],
	"liveCompanion:start": [0],
	"selfHealing:cancelOperation": [0],
	"selfHealing:cicd:config": [0],
	"selfHealing:cicd:disable": [0],
	"selfHealing:cicd:enable": [0],
	"selfHealing:dismissIncident": [0],
	"selfHealing:getDashboard": [0],
	"selfHealing:getFragility": [0],
	"selfHealing:getIncidents": [0],
	"selfHealing:getOperations": [0],
	"selfHealing:proactive:config": [0],
	"selfHealing:proactive:scan": [0],
	"selfHealing:production:config": [0],
	"selfHealing:production:connect": [0],
	"selfHealing:production:disconnect": [0],
	"selfHealing:retryIncident": [0],
	"selfHealing:triggerFix": [0],
	"shell:openTerminal": [0],
	"specApproval:approve": [0],
	"specApproval:getHistory": [0],
	"specApproval:getPendingSpecs": [0],
	"specApproval:getSpec": [0],
	"specApproval:reject": [0],
	"specApproval:requestChanges": [0],
	"task:loadImageThumbnail": [0],
	"task:worktreeDeleteFiles": [0],
	"task:worktreeOpenInIDE": [0],
	"task:worktreeOpenInTerminal": [0],
	"task:worktreeReadFile": [0],
	"task:worktreeWriteFile": [0],
	"terminal:clearSessions": [0],
	"terminal:getSessionDates": [0],
	"terminal:getSessions": [0],
	"terminal:getSessionsForDate": [1],
	"terminal:restoreFromDate": [1],
	"terminal:updateDisplayOrders": [0],
	"terminal:worktreeList": [0],
	"terminal:worktreeListOther": [0],
	"terminal:worktreeRemove": [0],
};

/** Keys of an object argument that name a project directory. */
export const DIRECTORY_KEYS = [
	"projectPath",
	"projectDir",
	"project_path",
	"project_dir",
] as const;

export const PATH_REFUSED =
	"This folder is not a registered project or a folder you picked";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/**
 * Whether `args` (the handler's arguments, event excluded) may reach the
 * handler of `channel`. An absent optional argument is let through: the
 * handler decides what nothing means.
 */
export function argsAllowed(channel: string, args: readonly unknown[]): boolean {
	for (const index of DIRECTORY_ARGS[channel] ?? []) {
		const value = args[index];
		if (value === undefined || value === null || value === "") continue;
		if (!resolveInProject(value, "directory")) return false;
	}
	for (const value of args) {
		if (!isPlainObject(value)) continue;
		for (const key of DIRECTORY_KEYS) {
			const dir = value[key];
			if (dir === undefined || dir === null || dir === "") continue;
			if (!resolveInProject(dir, "directory")) return false;
		}
	}
	return true;
}

let installed = false;

/** Wrap `ipc.handle` and `ipc.on` once, before any handler is registered. */
export function installIpcPathPolicy(ipc: Pick<IpcMain, "handle" | "on">): void {
	if (installed) return;
	installed = true;
	const handle = ipc.handle.bind(ipc);
	const on = ipc.on.bind(ipc);

	ipc.handle = ((channel: string, listener: Parameters<IpcMain["handle"]>[1]) =>
		handle(channel, (event, ...args) => {
			if (!argsAllowed(channel, args)) {
				console.warn(`[ipc-path-policy] refused ${channel}`);
				return { success: false, error: PATH_REFUSED };
			}
			return listener(event, ...args);
		})) as IpcMain["handle"];

	ipc.on = ((channel: string, listener: Parameters<IpcMain["on"]>[1]) =>
		on(channel, (event, ...args) => {
			if (!argsAllowed(channel, args)) {
				console.warn(`[ipc-path-policy] refused ${channel}`);
				return;
			}
			listener(event, ...args);
		})) as IpcMain["on"];
}

/** For tests: let the next `installIpcPathPolicy` wrap again. */
export function resetIpcPathPolicyForTests(): void {
	installed = false;
}
