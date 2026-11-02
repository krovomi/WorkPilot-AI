import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	MultiRepoCreateConfig,
	MultiRepoOrchestration,
} from "../../../shared/types";
import {
	createIpcListener,
	type IpcListenerCleanup,
	invokeIpc,
} from "./ipc-utils";

/**
 * Multi-Repo Orchestration API: one change across several repositories, each
 * run as a Kanban task of its own project.
 */
export interface MultiRepoAPI {
	createMultiRepoOrchestration: (
		projectId: string,
		config: MultiRepoCreateConfig,
	) => Promise<IPCResult<MultiRepoOrchestration>>;

	getMultiRepoOrchestration: (
		projectId: string,
		orchestrationId: string,
	) => Promise<IPCResult<MultiRepoOrchestration | null>>;

	listMultiRepoOrchestrations: (
		projectId: string,
	) => Promise<IPCResult<MultiRepoOrchestration[]>>;

	/** Starts, or resumes where it stopped. */
	startMultiRepoOrchestration: (
		projectId: string,
		orchestrationId: string,
	) => Promise<IPCResult>;

	stopMultiRepoOrchestration: (
		projectId: string,
		orchestrationId: string,
	) => Promise<IPCResult>;

	/** The whole orchestration, each time it changes. */
	onMultiRepoUpdated: (
		callback: (orchestration: MultiRepoOrchestration) => void,
	) => IpcListenerCleanup;
}

export const createMultiRepoAPI = (): MultiRepoAPI => ({
	createMultiRepoOrchestration: (projectId, config) =>
		invokeIpc(IPC_CHANNELS.MULTI_REPO_CREATE, projectId, config),

	getMultiRepoOrchestration: (projectId, orchestrationId) =>
		invokeIpc(IPC_CHANNELS.MULTI_REPO_GET, projectId, orchestrationId),

	listMultiRepoOrchestrations: (projectId) =>
		invokeIpc(IPC_CHANNELS.MULTI_REPO_LIST, projectId),

	startMultiRepoOrchestration: (projectId, orchestrationId) =>
		invokeIpc(IPC_CHANNELS.MULTI_REPO_START, projectId, orchestrationId),

	stopMultiRepoOrchestration: (projectId, orchestrationId) =>
		invokeIpc(IPC_CHANNELS.MULTI_REPO_STOP, projectId, orchestrationId),

	onMultiRepoUpdated: (callback) =>
		createIpcListener(IPC_CHANNELS.MULTI_REPO_UPDATED, callback),
});
