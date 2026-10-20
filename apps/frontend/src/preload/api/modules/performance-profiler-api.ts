/**
 * Performance Profiler Agent API module
 */

import { IPC_CHANNELS } from "../../../shared/constants";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface PerformanceProfilerRequest {
	projectDir: string;
	autoImplement?: boolean;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Re-exporte le type du service qui produit reellement ce resultat.
 *
 * Le handler transmet tel quel ce que le service emet
 * (`service.on("complete", (result) => webContents.send(..., result))`), donc
 * c'est ce type-la qui traverse le pont. Ce module en declarait un autre, de
 * forme differente, qu'aucun code ne produisait ; le store du renderer, lui,
 * importait deja le bon depuis le service. L'index signature d'`ElectronAPI`
 * rendait les deux interchangeables aux yeux du compilateur.
 */
import type { PerformanceProfilerResult } from "../../../main/performance-profiler-service";
export type { PerformanceProfilerResult };

export interface PerformanceProfilerAPI {
	startPerformanceProfiling: (
		request: PerformanceProfilerRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelPerformanceProfiling: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	configurePerformanceProfiler: (config: {
		pythonPath?: string;
	}) => Promise<{ success: boolean; error?: string }>;
	onPerformanceProfilerStatus: (
		callback: (status: string) => void,
	) => () => void;
	onPerformanceProfilerStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;
	onPerformanceProfilerError: (callback: (error: string) => void) => () => void;
	onPerformanceProfilerComplete: (
		callback: (result: PerformanceProfilerResult) => void,
	) => () => void;
	onPerformanceProfilerImplementationComplete: (
		callback: (result: unknown) => void,
	) => () => void;
}

export function createPerformanceProfilerAPI(): PerformanceProfilerAPI {
	return {
		startPerformanceProfiling: (request) =>
			invokeIpc("performanceProfiler:start", request),
		cancelPerformanceProfiling: () =>
			invokeIpc("performanceProfiler:cancel"),
		configurePerformanceProfiler: (config) =>
			invokeIpc("performanceProfiler:configure", config),
		onPerformanceProfilerStatus: (callback) =>
			createIpcListener(IPC_CHANNELS.PERFORMANCE_PROFILER_STATUS, callback),
		onPerformanceProfilerStreamChunk: (callback) =>
			createIpcListener(
				IPC_CHANNELS.PERFORMANCE_PROFILER_STREAM_CHUNK,
				callback,
			),
		onPerformanceProfilerError: (callback) =>
			createIpcListener(IPC_CHANNELS.PERFORMANCE_PROFILER_ERROR, callback),
		onPerformanceProfilerComplete: (callback) =>
			createIpcListener(IPC_CHANNELS.PERFORMANCE_PROFILER_COMPLETE, callback),
		onPerformanceProfilerImplementationComplete: (callback) =>
			createIpcListener(
				IPC_CHANNELS.PERFORMANCE_PROFILER_IMPLEMENTATION_COMPLETE,
				callback,
			),
	};
}
