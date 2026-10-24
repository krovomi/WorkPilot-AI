/**
 * Learning Loop API module
 *
 * Provides API methods for interacting with the Autonomous Agent Learning Loop.
 * Uses ipcRenderer utilities directly (not window.electronAPI) since this runs in a preload context.
 */

import type * as LearningLoopTypes from "../../../shared/types/learning-loop";
import { createIpcListener, invokeIpc, sendIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface LearningLoopAPI {
	// Operations
	getLearningPatterns: (projectId: string) => Promise<{
		success: boolean;
		data?: LearningLoopTypes.LearningPattern[];
		error?: string;
	}>;
	getLearningSummary: (projectId: string) => Promise<{
		success: boolean;
		data?: LearningLoopTypes.LearningSummary;
		error?: string;
	}>;
	runLearningAnalysis: (projectId: string, specId?: string) => void;
	stopLearningAnalysis: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	deleteLearningPattern: (
		projectId: string,
		patternId: string,
	) => Promise<{ success: boolean; error?: string }>;
	toggleLearningPattern: (
		projectId: string,
		patternId: string,
	) => Promise<{ success: boolean; data?: boolean; error?: string }>;

	// Event listeners
	onLearningLoopStatus: (callback: (status: string) => void) => () => void;
	onLearningLoopStreamChunk: (callback: (chunk: string) => void) => () => void;
	onLearningLoopError: (callback: (error: string) => void) => () => void;
	onLearningLoopComplete: (
		callback: (result: LearningLoopTypes.LearningLoopCompleteResult) => void,
	) => () => void;
}

/**
 * Create the Learning Loop API object
 */
export function createLearningLoopAPI(): LearningLoopAPI {
	return {
		// Operations
		getLearningPatterns: (projectId: string) =>
			invokeIpc(IPC_CHANNELS.LEARNING_LOOP_GET_PATTERNS, projectId),

		getLearningSummary: (projectId: string) =>
			invokeIpc(IPC_CHANNELS.LEARNING_LOOP_GET_SUMMARY, projectId),

		runLearningAnalysis: (projectId: string, specId?: string) =>
			sendIpc(IPC_CHANNELS.LEARNING_LOOP_RUN_ANALYSIS, projectId, specId),

		stopLearningAnalysis: () => invokeIpc(IPC_CHANNELS.LEARNING_LOOP_STOP_ANALYSIS),

		deleteLearningPattern: (projectId: string, patternId: string) =>
			invokeIpc(IPC_CHANNELS.LEARNING_LOOP_DELETE_PATTERN, projectId, patternId),

		toggleLearningPattern: (projectId: string, patternId: string) =>
			invokeIpc(IPC_CHANNELS.LEARNING_LOOP_TOGGLE_PATTERN, projectId, patternId),

		// Event listeners
		onLearningLoopStatus: (callback: (status: string) => void) =>
			createIpcListener<[string]>(IPC_CHANNELS.LEARNING_LOOP_STATUS, callback),

		onLearningLoopStreamChunk: (callback: (chunk: string) => void) =>
			createIpcListener<[string]>(IPC_CHANNELS.LEARNING_LOOP_STREAM_CHUNK, callback),

		onLearningLoopError: (callback: (error: string) => void) =>
			createIpcListener<[string]>(IPC_CHANNELS.LEARNING_LOOP_ERROR, callback),

		onLearningLoopComplete: (
			callback: (result: LearningLoopTypes.LearningLoopCompleteResult) => void,
		) =>
			createIpcListener<[LearningLoopTypes.LearningLoopCompleteResult]>(
				IPC_CHANNELS.LEARNING_LOOP_COMPLETE,
				callback,
			),
	};
}
