import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult, SecureStorageStatus } from "../../shared/types";
import {
	getSecureStorageStatus,
	onSecureStorageStatusChange,
	retrySecretEncryption,
	secureStorageFix,
} from "../secret-storage";

let unsubscribe: (() => void) | undefined;

/**
 * Whether stored secrets are protected by the OS keyring. The renderer warns
 * when they are not (docs/architecture/secrets-at-rest.md).
 */
export function registerSecureStorageHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SECURE_STORAGE_STATUS,
		(): IPCResult<SecureStorageStatus> => ({
			success: true,
			data: getSecureStorageStatus(),
		}),
	);

	// The banner's one-click fix. No argument: the main decides what it does
	// (rule S6). Under WSL, ask Windows DPAPI again and encrypt what is in
	// clear; elsewhere on Linux the keyring is chosen at launch, so relaunch.
	ipcMain.handle(
		IPC_CHANNELS.SECURE_STORAGE_FIX,
		async (): Promise<IPCResult<SecureStorageStatus>> => {
			const fix = secureStorageFix();
			if (fix === "restart") {
				app.relaunch();
				app.exit(0);
			} else if (fix === "retry") {
				await retrySecretEncryption();
			}
			return { success: true, data: getSecureStorageStatus() };
		},
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
