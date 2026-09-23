import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { JevCredentialStatus } from "../../shared/types/jev";
export interface JevAPI {
	getJevStatus(): Promise<IPCResult<JevCredentialStatus>>;
	saveJevKey(key: string): Promise<IPCResult<JevCredentialStatus>>;
	clearJevKey(): Promise<IPCResult<JevCredentialStatus>>;
}
export function createJevAPI(): JevAPI {
	return {
		getJevStatus: () => ipcRenderer.invoke(IPC_CHANNELS.JEV_STATUS),
		saveJevKey: (key) => ipcRenderer.invoke(IPC_CHANNELS.JEV_SAVE_KEY, key),
		clearJevKey: () => ipcRenderer.invoke(IPC_CHANNELS.JEV_CLEAR_KEY),
	};
}
