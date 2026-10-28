/**
 * Release Coordinator API
 *
 * Renderer-side bridge to the release coordinator runner.
 */

import type { ReleaseTrainPlan } from "../../../shared/types/release-coordinator";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface ReleaseCoordinatorRunOptions {
	projectPath: string;
	maxCommits?: number;
}

export interface ReleaseCoordinatorEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; services?: number };
}

export interface ReleaseCoordinatorAPI {
	runReleaseCoordinatorPlan: (
		options: ReleaseCoordinatorRunOptions,
	) => Promise<ReleaseTrainPlan>;
	cancelReleaseCoordinatorPlan: () => Promise<boolean>;
	onReleaseCoordinatorEvent: (
		callback: (event: ReleaseCoordinatorEvent) => void,
	) => () => void;
	onReleaseCoordinatorResult: (
		callback: (plan: ReleaseTrainPlan) => void,
	) => () => void;
	onReleaseCoordinatorError: (
		callback: (error: string) => void,
	) => () => void;
}

export const createReleaseCoordinatorAPI = (): ReleaseCoordinatorAPI => ({
	runReleaseCoordinatorPlan: (options: ReleaseCoordinatorRunOptions) =>
		invokeIpc<ReleaseTrainPlan>(IPC_CHANNELS.RELEASE_COORDINATOR_RUN, options),

	cancelReleaseCoordinatorPlan: () =>
		invokeIpc<boolean>(IPC_CHANNELS.RELEASE_COORDINATOR_CANCEL),

	onReleaseCoordinatorEvent: (callback) =>
		createIpcListener<[ReleaseCoordinatorEvent]>(
			IPC_CHANNELS.RELEASE_COORDINATOR_EVENT,
			(payload) => callback(payload),
		),

	onReleaseCoordinatorResult: (callback) =>
		createIpcListener<[ReleaseTrainPlan]>(
			IPC_CHANNELS.RELEASE_COORDINATOR_RESULT,
			(payload) => callback(payload),
		),

	onReleaseCoordinatorError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.RELEASE_COORDINATOR_ERROR, (payload) =>
			callback(payload),
		),
});
