/**
 * Automations API: a project's rules (an event creates a Kanban card), what
 * they did, and a pass on demand. See main/ipc-handlers/automations-handlers.ts.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	AutomationsEvent,
	AutomationsState,
	IPCResult,
} from "../../../shared/types";
import { createIpcListener, invokeIpc } from "./ipc-utils";

/** A rule as the renderer sends it; the main process checks every field. */
export type AutomationRuleInput = Record<string, unknown>;

export interface AutomationsAPI {
	get: (projectId: string) => Promise<IPCResult<AutomationsState>>;
	save: (
		projectId: string,
		rule: AutomationRuleInput,
	) => Promise<IPCResult<AutomationsState>>;
	remove: (
		projectId: string,
		ruleId: string,
	) => Promise<IPCResult<AutomationsState>>;
	run: (projectId: string) => Promise<IPCResult<AutomationsState>>;
	onEvent: (callback: (event: AutomationsEvent) => void) => () => void;
}

export const createAutomationsAPI = (): AutomationsAPI => ({
	get: (projectId) =>
		invokeIpc<IPCResult<AutomationsState>>(IPC_CHANNELS.AUTOMATIONS_GET, projectId),
	save: (projectId, rule) =>
		invokeIpc<IPCResult<AutomationsState>>(
			IPC_CHANNELS.AUTOMATIONS_SAVE,
			projectId,
			rule,
		),
	remove: (projectId, ruleId) =>
		invokeIpc<IPCResult<AutomationsState>>(
			IPC_CHANNELS.AUTOMATIONS_DELETE,
			projectId,
			ruleId,
		),
	run: (projectId) =>
		invokeIpc<IPCResult<AutomationsState>>(IPC_CHANNELS.AUTOMATIONS_RUN, projectId),
	onEvent: (callback) =>
		createIpcListener<[AutomationsEvent]>(IPC_CHANNELS.AUTOMATIONS_EVENT, (payload) =>
			callback(payload),
		),
});
