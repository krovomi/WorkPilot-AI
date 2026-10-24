/**
 * Pipeline Generator API module
 */

import type {
	CiPlatform,
	PipelineGeneratorRequest,
	PipelineGeneratorResult,
} from "../../../main/pipeline-generator-service";
import {
	createIpcListener,
	type IpcListenerCleanup,
	invokeIpc,
} from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export type { CiPlatform, PipelineGeneratorRequest, PipelineGeneratorResult };

export interface PipelineGeneratorAPI {
	generatePipelines: (
		request: PipelineGeneratorRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelPipelineGeneration: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	onPipelineGeneratorStatus: (
		callback: (status: string) => void,
	) => IpcListenerCleanup;
	onPipelineGeneratorStreamChunk: (
		callback: (chunk: string) => void,
	) => IpcListenerCleanup;
	onPipelineGeneratorError: (
		callback: (error: string) => void,
	) => IpcListenerCleanup;
	onPipelineGeneratorComplete: (
		callback: (result: PipelineGeneratorResult) => void,
	) => IpcListenerCleanup;
}

export function createPipelineGeneratorAPI(): PipelineGeneratorAPI {
	return {
		generatePipelines: (request) =>
			invokeIpc<{ success: boolean; error?: string }>(
				IPC_CHANNELS.PIPELINE_GENERATOR_GENERATE,
				request,
			),
		cancelPipelineGeneration: () =>
			invokeIpc<{ success: boolean; cancelled: boolean; error?: string }>(
				IPC_CHANNELS.PIPELINE_GENERATOR_CANCEL,
			),
		onPipelineGeneratorStatus: (callback) =>
			createIpcListener<[string]>(IPC_CHANNELS.PIPELINE_GENERATOR_STATUS, callback),
		onPipelineGeneratorStreamChunk: (callback) =>
			createIpcListener<[string]>(IPC_CHANNELS.PIPELINE_GENERATOR_STREAM_CHUNK, callback),
		onPipelineGeneratorError: (callback) =>
			createIpcListener<[string]>(IPC_CHANNELS.PIPELINE_GENERATOR_ERROR, callback),
		onPipelineGeneratorComplete: (callback) =>
			createIpcListener<[PipelineGeneratorResult]>(
				IPC_CHANNELS.PIPELINE_GENERATOR_COMPLETE,
				callback,
			),
	};
}
