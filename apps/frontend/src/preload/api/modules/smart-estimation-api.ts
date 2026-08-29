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
		invokeIpc("run-smart-estimation", { projectId, taskDescription }),

	cancelSmartEstimation: () => invokeIpc("cancel-smart-estimation"),

	onSmartEstimationEvent: (callback) =>
		createIpcListener<[SmartEstimationEvent]>(
			"smart-estimation-event",
			callback,
		),

	onSmartEstimationError: (callback) =>
		createIpcListener<[string]>("smart-estimation-error", callback),

	onSmartEstimationComplete: (callback) =>
		createIpcListener<[SmartEstimationResult]>(
			"smart-estimation-complete",
			callback,
		),
});

// Note: This module exports functions that are integrated into the main ElectronAPI
// The contextBridge exposure is handled in the main preload/index.ts file
