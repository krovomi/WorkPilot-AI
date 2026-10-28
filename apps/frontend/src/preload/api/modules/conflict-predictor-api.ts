/**
 * Conflict Predictor API
 *
 * Provides API interface for Conflict Predictor functionality
 */

import type {
	ConflictPredictionEvent,
	ConflictPredictionResult,
} from "../../../renderer/stores/conflict-predictor-store";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface ConflictPredictorAPI {
	runConflictPrediction: (projectId: string) => Promise<void>;
	cancelConflictPrediction: () => Promise<boolean>;
	onConflictPredictionStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;
	onConflictPredictionStatus: (
		callback: (status: string) => void,
	) => () => void;
	onConflictPredictionError: (callback: (error: string) => void) => () => void;
	onConflictPredictionComplete: (
		callback: (result: ConflictPredictionResult) => void,
	) => () => void;
	onConflictPredictionEvent: (
		callback: (event: ConflictPredictionEvent) => void,
	) => () => void;
}

export const createConflictPredictorAPI = (): ConflictPredictorAPI => ({
	runConflictPrediction: (projectId: string) =>
		invokeIpc(IPC_CHANNELS.RUN_CONFLICT_PREDICTION, { projectId }),

	cancelConflictPrediction: () => invokeIpc(IPC_CHANNELS.CANCEL_CONFLICT_PREDICTION),

	onConflictPredictionStreamChunk: (callback: (chunk: string) => void) => {
		return createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		});
	},

	onConflictPredictionStatus: (callback: (status: string) => void) => {
		return createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		});
	},

	onConflictPredictionError: (callback: (error: string) => void) => {
		return createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_ERROR, (error: string) => {
			callback(error);
		});
	},

	onConflictPredictionComplete: (callback: (result: ConflictPredictionResult) => void) => {
		return createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_COMPLETE, (result: ConflictPredictionResult) => {
			callback(result);
		});
	},

	onConflictPredictionEvent: (callback: (event: ConflictPredictionEvent) => void) => {
		return createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			callback(event);
		});
	},
});

export const conflictPredictorAPI: ConflictPredictorAPI = {
	runConflictPrediction: (projectId: string) =>
		invokeIpc(IPC_CHANNELS.RUN_CONFLICT_PREDICTION, { projectId }),

	cancelConflictPrediction: () => invokeIpc(IPC_CHANNELS.CANCEL_CONFLICT_PREDICTION),

	onConflictPredictionStreamChunk: (callback: (chunk: string) => void) =>
		createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		}),

	onConflictPredictionStatus: (callback: (status: string) => void) =>
		createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			if (event.type === "progress" && event.data.status) {
				callback(event.data.status);
			}
		}),

	onConflictPredictionError: (callback: (error: string) => void) =>
		createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_ERROR, (error: string) => {
			callback(error);
		}),

	onConflictPredictionComplete: (callback: (result: ConflictPredictionResult) => void) =>
		createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_COMPLETE, (result: ConflictPredictionResult) => {
			callback(result);
		}),

	onConflictPredictionEvent: (callback: (event: ConflictPredictionEvent) => void) =>
		createIpcListener(IPC_CHANNELS.CONFLICT_PREDICTOR_EVENT, (event: ConflictPredictionEvent) => {
			callback(event);
		}),
};
