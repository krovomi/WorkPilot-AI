/**
 * Smart Estimation API
 *
 * Bridges the three channels the main process actually emits:
 * `smart-estimation-event` (progress, `{type, data, timestamp}`),
 * `smart-estimation-error` and `smart-estimation-complete`.
 *
 * There is deliberately no stream-chunk or status listener here: nothing
 * emits those channels. Status is carried inside the progress event, and the
 * renderer derives it there rather than waiting on a channel that never fires.
 */

import type {
	SmartEstimationEvent,
	SmartEstimationResult,
} from "../../../shared/types/smart-estimation";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface SmartEstimationAPI {
	runSmartEstimation: (
		projectId: string,
		taskDescription: string,
	) => Promise<SmartEstimationResult>;
	cancelSmartEstimation: () => Promise<boolean>;
	onSmartEstimationEvent: (
		callback: (event: SmartEstimationEvent) => void,
	) => () => void;
	onSmartEstimationError: (callback: (error: string) => void) => () => void;
	onSmartEstimationComplete: (
		callback: (result: SmartEstimationResult) => void,
	) => () => void;
}

export const createSmartEstimationAPI = (): SmartEstimationAPI => ({
	runSmartEstimation: (projectId: string, taskDescription: string) =>
		invokeIpc(IPC_CHANNELS.RUN_SMART_ESTIMATION, { projectId, taskDescription }),

	cancelSmartEstimation: () => invokeIpc(IPC_CHANNELS.CANCEL_SMART_ESTIMATION),

	onSmartEstimationEvent: (callback) =>
		createIpcListener<[SmartEstimationEvent]>(
			IPC_CHANNELS.SMART_ESTIMATION_EVENT,
			callback,
		),

	onSmartEstimationError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.SMART_ESTIMATION_ERROR, callback),

	onSmartEstimationComplete: (callback) =>
		createIpcListener<[SmartEstimationResult]>(
			IPC_CHANNELS.SMART_ESTIMATION_COMPLETE,
			callback,
		),
});

// Note: This module exports functions that are integrated into the main ElectronAPI
// The contextBridge exposure is handled in the main preload/index.ts file
