/**
 * Server Usage API: the renderer's bridge to `main/server-usage.ts`.
 *
 * `notePageVisit` tells the main which view opened; the main counts it only
 * for a known view, in server mode, while the organization has page activity
 * on. The other calls are relayed to the server, which decides; the main
 * checks their arguments first.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	MyUsage,
	UsageExport,
	UsageNotice,
	UsagePersonSheet,
	UsageQuery,
	UsageResult,
	UsageSettings,
	UsageSettingsUpdate,
	UsageView,
} from "../../../shared/types/server-usage";
import { invokeIpc, sendIpc } from "./ipc-utils";

export interface ServerUsageAPI {
	notePageVisit: (page: string) => void;
	getUsageSettings: () => Promise<UsageResult<UsageSettings>>;
	setUsageSettings: (body: UsageSettingsUpdate) => Promise<UsageResult<UsageSettings>>;
	getUsageView: <T>(view: UsageView, query: UsageQuery) => Promise<UsageResult<T>>;
	getUsagePerson: (personId: string, query: UsageQuery) => Promise<UsageResult<UsagePersonSheet>>;
	exportUsage: (view: UsageExport, query: UsageQuery) => Promise<UsageResult<string>>;
	getMyUsage: (query: UsageQuery) => Promise<UsageResult<MyUsage>>;
	exportMyUsage: () => Promise<UsageResult<string>>;
	getUsageNotice: () => Promise<UsageResult<UsageNotice>>;
	markUsageNoticeSeen: () => Promise<UsageResult<UsageNotice>>;
	eraseAccount: (userId: string, confirmEmail: string) => Promise<UsageResult<{ erased: boolean }>>;
}

export const createServerUsageAPI = (): ServerUsageAPI => ({
	notePageVisit: (page) => sendIpc(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, page),
	getUsageSettings: () => invokeIpc(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS),
	setUsageSettings: (body) => invokeIpc(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, body),
	getUsageView: (view, query) => invokeIpc(IPC_CHANNELS.SERVER_USAGE_VIEW, view, query),
	getUsagePerson: (personId, query) =>
		invokeIpc(IPC_CHANNELS.SERVER_USAGE_PERSON, personId, query),
	exportUsage: (view, query) => invokeIpc(IPC_CHANNELS.SERVER_USAGE_EXPORT, view, query),
	getMyUsage: (query) => invokeIpc(IPC_CHANNELS.SERVER_USAGE_MINE, query),
	exportMyUsage: () => invokeIpc(IPC_CHANNELS.SERVER_USAGE_EXPORT_MINE),
	getUsageNotice: () => invokeIpc(IPC_CHANNELS.SERVER_USAGE_NOTICE),
	markUsageNoticeSeen: () => invokeIpc(IPC_CHANNELS.SERVER_USAGE_NOTICE_SEEN),
	eraseAccount: (userId, confirmEmail) =>
		invokeIpc(IPC_CHANNELS.SERVER_USAGE_ERASE_ACCOUNT, userId, confirmEmail),
});
