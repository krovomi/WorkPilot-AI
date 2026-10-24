/**
 * Context Mesh events
 *
 * The analysis runs in main once the renderer starts it, and reports
 * through these four events. Nothing in the preload listened to them, so the
 * dashboard stayed on "Starting analysis..." until it was closed: the status,
 * the streamed output, the error and the end of the run never arrived.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createIpcListener, type IpcListenerCleanup } from "./ipc-utils";

export interface ContextMeshAPI {
	onContextMeshStatus: (callback: (status: string) => void) => IpcListenerCleanup;
	onContextMeshStreamChunk: (
		callback: (chunk: string) => void,
	) => IpcListenerCleanup;
	onContextMeshError: (callback: (error: string) => void) => IpcListenerCleanup;
	onContextMeshComplete: (
		callback: (result: unknown) => void,
	) => IpcListenerCleanup;
}

export const createContextMeshAPI = (): ContextMeshAPI => ({
	onContextMeshStatus: (callback) =>
		createIpcListener(IPC_CHANNELS.CONTEXT_MESH_STATUS, callback),
	onContextMeshStreamChunk: (callback) =>
		createIpcListener(IPC_CHANNELS.CONTEXT_MESH_STREAM_CHUNK, callback),
	onContextMeshError: (callback) =>
		createIpcListener(IPC_CHANNELS.CONTEXT_MESH_ERROR, callback),
	onContextMeshComplete: (callback) =>
		createIpcListener(IPC_CHANNELS.CONTEXT_MESH_COMPLETE, callback),
});
