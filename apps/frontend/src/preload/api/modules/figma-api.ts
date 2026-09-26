import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

/**
 * Figma: the project's token is written through the main process and never
 * read back — the renderer only learns whether one is configured.
 */
export interface FigmaAPI {
	getFigmaTokenStatus: (
		projectId: string,
	) => Promise<IPCResult<{ configured: boolean; fromEnvironment: boolean }>>;
	/** An empty string removes the token. */
	setFigmaToken: (projectId: string, token: string) => Promise<IPCResult<boolean>>;
}

export const createFigmaAPI = (): FigmaAPI => ({
	getFigmaTokenStatus: (projectId: string) =>
		invokeIpc(IPC_CHANNELS.FIGMA_TOKEN_STATUS, projectId),
	setFigmaToken: (projectId: string, token: string) =>
		invokeIpc(IPC_CHANNELS.FIGMA_SET_TOKEN, projectId, token),
});
