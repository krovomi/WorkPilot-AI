/**
 * Release Coordinator API
 *
 * Renderer-side bridge to the release coordinator runner.
 */

import type { ReleaseTrainPlan } from "../../../shared/types/release-coordinator";
import type {
	TrainAction,
	TrainMonth,
	TrainNotes,
	TrainRun,
	TrainState,
} from "../../../shared/types/release-train";
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
	releaseTrainState: (projectPath: string) => Promise<TrainState>;
	approveReleaseTrain: (projectPath: string, sha256: string) => Promise<boolean>;
	startReleaseTrain: (options: {
		projectPath: string;
		environment: string;
		services?: string[];
		express?: boolean;
	}) => Promise<TrainRun>;
	advanceReleaseTrain: (options: {
		projectPath: string;
		runId: string;
		action: TrainAction;
		target?: string;
	}) => Promise<TrainRun>;
	releaseTrainRun: (projectPath: string, runId: string) => Promise<TrainRun>;
	releaseTrainMetrics: (projectPath: string) => Promise<{ months: TrainMonth[] }>;
	releaseTrainNotes: (projectPath: string, ai: boolean) => Promise<TrainNotes>;
	onReleaseTrainEvent: (
		callback: (event: ReleaseTrainEvent) => void,
	) => () => void;
}

export interface ReleaseTrainEvent {
	projectPath: string;
	kind: "step" | "waiting" | "blocked" | "finished";
	service?: string;
	step?: string;
	status?: string;
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

	releaseTrainState: (projectPath) =>
		invokeIpc<TrainState>(IPC_CHANNELS.RELEASE_TRAIN_STATE, { projectPath }),
	approveReleaseTrain: (projectPath, sha256) =>
		invokeIpc<boolean>(IPC_CHANNELS.RELEASE_TRAIN_APPROVE, { projectPath, sha256 }),
	startReleaseTrain: (options) => invokeIpc<TrainRun>(IPC_CHANNELS.RELEASE_TRAIN_START, options),
	advanceReleaseTrain: (options) => invokeIpc<TrainRun>(IPC_CHANNELS.RELEASE_TRAIN_ADVANCE, options),
	releaseTrainRun: (projectPath, runId) =>
		invokeIpc<TrainRun>(IPC_CHANNELS.RELEASE_TRAIN_RUN, { projectPath, runId }),
	releaseTrainMetrics: (projectPath) =>
		invokeIpc<{ months: TrainMonth[] }>(IPC_CHANNELS.RELEASE_TRAIN_METRICS, { projectPath }),
	releaseTrainNotes: (projectPath, ai) =>
		invokeIpc<TrainNotes>(IPC_CHANNELS.RELEASE_TRAIN_NOTES, { projectPath, ai }),
	onReleaseTrainEvent: (callback) =>
		createIpcListener<[ReleaseTrainEvent]>(IPC_CHANNELS.RELEASE_TRAIN_EVENT, (payload) =>
			callback(payload),
		),
});
