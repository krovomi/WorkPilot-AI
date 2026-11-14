/**
 * The local backend, reached by main (`main/ipc-handlers/local-backend-handlers.ts`):
 * the renderer has no backend URL of its own.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	LocalBackendRequest,
	LocalBackendResponse,
} from "../../../shared/types/local-backend";
import { invokeIpc } from "./ipc-utils";

export interface LocalBackendAPI {
	localBackendRequest: (request: LocalBackendRequest) => Promise<LocalBackendResponse>;
}

export const createLocalBackendAPI = (): LocalBackendAPI => ({
	localBackendRequest: (request) =>
		invokeIpc(IPC_CHANNELS.LOCAL_BACKEND_REQUEST, request),
});
