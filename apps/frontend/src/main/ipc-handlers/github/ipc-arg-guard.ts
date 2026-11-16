/**
 * An `ipcMain` that checks a handler's arguments before the handler runs.
 * Each forge module (`pr-ipc-guard.ts`, `autofix-ipc-guard.ts`,
 * `gitlab/mr-ipc-guard.ts`) gives its own checks, one per channel, of the
 * arguments after the project id; a module whose channels take no project id
 * (`terminal/terminal-ipc-guard.ts`) has its checks read every argument. A
 * refused `invoke` rejects with the module's message; a refused `send` is
 * dropped.
 */

import { ipcMain } from "electron";

type HandleListener = Parameters<typeof ipcMain.handle>[1];
type OnListener = Parameters<typeof ipcMain.on>[1];

/** Each channel's check of the arguments after the project id. */
export type ArgChecks = Record<string, (args: unknown[]) => boolean>;

/** More issues or pull requests than a list ever shows at once. */
export const MAX_BATCH = 500;

export const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const isText = (value: unknown): value is string => typeof value === "string";
export const isNumberList = (value: unknown): value is number[] =>
	Array.isArray(value) && value.length <= MAX_BATCH && value.every(isNumber);

/**
 * Whether the arguments a channel received may reach its handler; the check
 * sees them after the first `skip` (the project id by default).
 */
export function argsAllowed(checks: ArgChecks, channel: string, args: unknown[], skip = 1): boolean {
	const check = checks[channel];
	return !check || check(args.slice(skip));
}

export function guardedIpcMain(checks: ArgChecks, refusal: string, skip = 1) {
	return {
		handle(channel: string, listener: HandleListener): void {
			ipcMain.handle(channel, (event, ...args) => {
				if (!argsAllowed(checks, channel, args, skip)) throw new Error(refusal);
				return listener(event, ...args);
			});
		},
		on(channel: string, listener: OnListener): void {
			ipcMain.on(channel, (event, ...args) => {
				if (argsAllowed(checks, channel, args, skip)) listener(event, ...args);
			});
		},
	};
}
