/**
 * IPC surface for usage in server mode (`main/server-usage.ts`): a view the
 * person opened, and the organization's usage settings. The renderer's page
 * name and settings are checked in `server-usage.ts` before anything leaves;
 * the server decides who may read or change the settings.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { getUsageSettings, notePageVisit, setUsageSettings } from "../server-usage";

export function registerServerUsageHandlers(): void {
	// One-way: counting a view never holds the renderer up nor reports back.
	ipcMain.on(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, (_e, page: unknown) => {
		void notePageVisit(page).catch(() => false);
	});
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS, () => getUsageSettings());
	ipcMain.handle(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, (_e, body: unknown) =>
		setUsageSettings(body),
	);
}
