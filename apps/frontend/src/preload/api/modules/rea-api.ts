/**
 * REA API for the renderer: is the pinned `rea-agents` release installed, and
 * installing exactly that release. Neither call takes an argument.
 */

import type { ReaInstallResult, ReaStatus } from "../../../shared/types/rea";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { invokeIpc } from "./ipc-utils";

export interface ReaAPI {
	checkRea: () => Promise<ReaStatus>;
	installRea: () => Promise<ReaInstallResult>;
}

export const createReaAPI = (): ReaAPI => ({
	checkRea: (): Promise<ReaStatus> => invokeIpc<ReaStatus>(IPC_CHANNELS.REA_CHECK),
	installRea: (): Promise<ReaInstallResult> =>
		invokeIpc<ReaInstallResult>(IPC_CHANNELS.REA_INSTALL),
});
