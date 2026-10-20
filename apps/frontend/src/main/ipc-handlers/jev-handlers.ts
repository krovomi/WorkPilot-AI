import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { getJevService } from "../jev/service";
export function registerJevHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.JEV_STATUS, () => ({
		success: true,
		data: getJevService().getStatus(),
	}));
	ipcMain.handle(IPC_CHANNELS.JEV_SAVE_KEY, (_event, key: string) => {
		try {
			getJevService().save(key);
			return { success: true, data: getJevService().getStatus() };
		} catch {
			return { success: false, error: "jev-save-failed" };
		}
	});
	ipcMain.handle(IPC_CHANNELS.JEV_CLEAR_KEY, () => {
		try {
			getJevService().clear();
			return { success: true, data: getJevService().getStatus() };
		} catch {
			return { success: false, error: "jev-clear-failed" };
		}
	});
}
