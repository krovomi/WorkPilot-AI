import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { SecureStorageStatus } from "../../shared/types/secure-storage";
import {
	getSecureStorageStatus,
	onSecureStorageStatusChange,
} from "../secret-storage";

let unsubscribe: (() => void) | undefined;

/**
 * Whether stored secrets are protected by the OS keyring. The renderer warns
 * when they are not (shared_docs/architecture/secrets-at-rest.md).
 */
export function registerSecureStorageHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SECURE_STORAGE_STATUS,
		(): IPCResult<SecureStorageStatus> => ({
			success: true,
			data: getSecureStorageStatus(),
		}),
	);

	unsubscribe?.();
	unsubscribe = onSecureStorageStatusChange((status) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) {
				window.webContents.send(
					IPC_CHANNELS.SECURE_STORAGE_STATUS_CHANGED,
					status,
				);
			}
		}
	});
}
