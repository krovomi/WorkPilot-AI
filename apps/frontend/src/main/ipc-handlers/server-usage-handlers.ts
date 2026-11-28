/**
 * IPC surface for usage in server mode: a view the person opened and the
 * organization's usage settings (`main/server-usage.ts`), the Usage tab's
 * figures, the person's own usage, the notice and account erasure
 * (`main/server-usage-views.ts`), the usage report and the token budgets
 * (`main/server-usage-report.ts`). Every argument from the renderer is checked
 * there before anything leaves; the server decides who may read or change.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { getUsageSettings, notePageVisit, setUsageSettings } from "../server-usage";
import {
	getBudgets,
	getReport,
	getReportSettings,
	removeBudget,
	sendReportNow,
	setBudget,
	setReportSettings,
} from "../server-usage-report";
import {
	eraseAccount,
	exportMyUsage,
	exportUsage,
	getMyUsage,
	getUsageNotice,
	getUsagePerson,
	getUsageView,
	markUsageNoticeSeen,
} from "../server-usage-views";

export function registerServerUsageHandlers(): void {
	// One-way: counting a view never holds the renderer up nor reports back.
	ipcMain.on(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, (_e, page: unknown) => {
		void notePageVisit(page).catch(() => false);
	});
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS, () => getUsageSettings());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, (_e, body: unknown) =>
		setUsageSettings(body),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_VIEW, (_e, view: unknown, query: unknown) =>
		getUsageView(view, query),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_PERSON, (_e, personId: unknown, query: unknown) =>
		getUsagePerson(personId, query),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_EXPORT, (_e, view: unknown, query: unknown) =>
		exportUsage(view, query),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_MINE, (_e, query: unknown) => getMyUsage(query));
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_EXPORT_MINE, () => exportMyUsage());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_NOTICE, () => getUsageNotice());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_NOTICE_SEEN, () => markUsageNoticeSeen());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_USAGE_ERASE_ACCOUNT,
		(_e, userId: unknown, confirmEmail: unknown) => eraseAccount(userId, confirmEmail),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_GET_REPORT_SETTINGS, () => getReportSettings());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_SET_REPORT_SETTINGS, (_e, body: unknown) =>
		setReportSettings(body),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_REPORT, (_e, kind: unknown, day: unknown) =>
		getReport(kind, day),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_SEND_REPORT, () => sendReportNow());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_BUDGETS, () => getBudgets());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_SET_BUDGET, (_e, body: unknown) => setBudget(body));
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_REMOVE_BUDGET, (_e, budgetId: unknown) =>
		removeBudget(budgetId),
	);
}
