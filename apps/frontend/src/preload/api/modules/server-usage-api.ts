/**
 * Server Usage API: the renderer's bridge to `main/server-usage.ts`.
 *
 * `notePageVisit` tells the main which view opened; the main counts it only
 * for a known view, in server mode, while the organization has page activity
 * on. The settings calls are relayed to the server, which decides.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	UsageResult,
	UsageSettings,
	UsageSettingsUpdate,
} from "../../../shared/types/server-usage";
import { invokeIpc, sendIpc } from "./ipc-utils";

export interface ServerUsageAPI {
	notePageVisit: (page: string) => void;
	getUsageSettings: () => Promise<UsageResult<UsageSettings>>;
	setUsageSettings: (body: UsageSettingsUpdate) => Promise<UsageResult<UsageSettings>>;
}

export const createServerUsageAPI = (): ServerUsageAPI => ({
	notePageVisit: (page) => sendIpc(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, page),
	getUsageSettings: () => invokeIpc(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS),
	setUsageSettings: (body) => invokeIpc(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, body),
});
