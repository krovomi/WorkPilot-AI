import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { SecureStorageStatus } from "../../shared/types/secure-storage";
import { createIpcListener } from "./modules/ipc-utils";

export interface SecureStorageAPI {
	getSecureStorageStatus(): Promise<IPCResult<SecureStorageStatus>>;
	onSecureStorageStatusChanged(
		callback: (status: SecureStorageStatus) => void,
	): () => void;
}

export function createSecureStorageAPI(): SecureStorageAPI {
	return {
		getSecureStorageStatus: () =>
			ipcRenderer.invoke(IPC_CHANNELS.SECURE_STORAGE_STATUS),
		onSecureStorageStatusChanged: (callback) =>
			createIpcListener<[SecureStorageStatus]>(
				IPC_CHANNELS.SECURE_STORAGE_STATUS_CHANGED,
				(status) => callback(status),
			),
	};
}
