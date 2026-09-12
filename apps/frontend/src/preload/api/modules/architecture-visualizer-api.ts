/**
 * Architecture Visualizer API module.
 *
 * Types are re-exported from the service that actually produces them: the
 * handler forwards the service's payload untouched, so that is the type
 * crossing the bridge. This module used to declare its own, of a different
 * shape, that nothing produced — and `ElectronAPI`'s index signature made the
 * two interchangeable to the compiler.
 */

import type {
	ArchitectureDeltaRequest,
	ArchitectureDeltaStatus,
	ArchitectureMapRequest,
	ArchitectureVisualizerResult,
} from "../../../main/architecture-visualizer-service";
import { IPC_CHANNELS } from "../../../shared/constants";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export type {
	ArchitectureDeltaRequest,
	ArchitectureDeltaStatus,
	ArchitectureMapRequest,
	ArchitectureVisualizerResult,
};

export interface ArchitectureVisualizerAPI {
	/** Author (or re-author) the project's baseline model. Long-running. */
	generateArchitectureMap: (
		request: ArchitectureMapRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelArchitectureVisualization: () => Promise<{
		success: boolean;
		cancelled?: boolean;
		error?: string;
	}>;
	configureArchitectureVisualizer: (config: {
		pythonPath?: string;
		autoBuildSourcePath?: string;
	}) => Promise<{ success: boolean; error?: string }>;
	/** Cheap: reads files and asks `node --version`. Safe to call on every open. */
	checkArchifyReadiness: (projectDir: string) => Promise<{
		success: boolean;
		data?: ArchitectureVisualizerResult;
		error?: string;
	}>;
	/** The recorded delta for one task, or `null` when it was never mapped. */
	readArchitectureDelta: (specDir: string) => Promise<{
		success: boolean;
		data?: ArchitectureDeltaStatus | null;
		error?: string;
	}>;
	regenerateArchitectureDelta: (
		request: ArchitectureDeltaRequest,
	) => Promise<{ success: boolean; error?: string }>;
	/** A `file://` URL for a <webview>, once the artifact is known to exist. */
	resolveArchitectureArtifact: (artifactPath: string) => Promise<{
		success: boolean;
		data?: { url: string };
		error?: string;
	}>;
	onArchitectureVisualizerStatus: (
		callback: (status: string) => void,
	) => () => void;
	onArchitectureVisualizerStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;
	onArchitectureVisualizerError: (
		callback: (error: string) => void,
	) => () => void;
	onArchitectureVisualizerComplete: (
		callback: (result: ArchitectureVisualizerResult) => void,
	) => () => void;
	onArchitectureDeltaStatus: (
		callback: (status: ArchitectureDeltaStatus) => void,
	) => () => void;
}

export function createArchitectureVisualizerAPI(): ArchitectureVisualizerAPI {
	return {
		generateArchitectureMap: (request) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_GENERATE, request),
		cancelArchitectureVisualization: () =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_CANCEL),
		configureArchitectureVisualizer: (config) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_CONFIGURE, config),
		checkArchifyReadiness: (projectDir) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_DOCTOR, projectDir),
		readArchitectureDelta: (specDir) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_DELTA_READ, specDir),
		regenerateArchitectureDelta: (request) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_DELTA_REGENERATE, request),
		resolveArchitectureArtifact: (artifactPath) =>
			invokeIpc(IPC_CHANNELS.ARCHITECTURE_ARTIFACT_READ, artifactPath),
		onArchitectureVisualizerStatus: (callback) =>
			createIpcListener(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_STATUS, callback),
		onArchitectureVisualizerStreamChunk: (callback) =>
			createIpcListener(
				IPC_CHANNELS.ARCHITECTURE_VISUALIZER_STREAM_CHUNK,
				callback,
			),
		onArchitectureVisualizerError: (callback) =>
			createIpcListener(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_ERROR, callback),
		onArchitectureVisualizerComplete: (callback) =>
			createIpcListener(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_COMPLETE, callback),
		onArchitectureDeltaStatus: (callback) =>
			createIpcListener(IPC_CHANNELS.ARCHITECTURE_DELTA_STATUS, callback),
	};
}
