/**
 * Architecture Visualizer API module
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface ArchitectureVisualizerRequest {
	projectDir: string;
	diagramTypes?: string[];
	outputDir?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface ArchitectureVisualizerResult {
	project_dir: string;
	diagram_types_analyzed: string[];
	diagrams: Record<
		string,
		{
			title: string;
			mermaid_code: string;
			nodes?: unknown[];
			edges?: unknown[];
		}
	>;
	output_dir: string;
	summary: { total_diagrams: number; total_nodes: number; total_edges: number };
}

export interface ArchitectureVisualizerAPI {
	generateArchitectureDiagrams: (
		request: ArchitectureVisualizerRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelArchitectureVisualization: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	configureArchitectureVisualizer: (config: {
		pythonPath?: string;
	}) => Promise<{ success: boolean; error?: string }>;
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
}

export function createArchitectureVisualizerAPI(): ArchitectureVisualizerAPI {
	return {
		generateArchitectureDiagrams: (request) =>
			invokeIpc("architectureVisualizer:generate", request),
		cancelArchitectureVisualization: () =>
			invokeIpc("architectureVisualizer:cancel"),
		configureArchitectureVisualizer: (config) =>
			invokeIpc("architectureVisualizer:configure", config),
		onArchitectureVisualizerStatus: (callback) =>
			createIpcListener("architectureVisualizer:status", callback),
		onArchitectureVisualizerStreamChunk: (callback) =>
			createIpcListener("architectureVisualizer:streamChunk", callback),
		onArchitectureVisualizerError: (callback) =>
			createIpcListener("architectureVisualizer:error", callback),
		onArchitectureVisualizerComplete: (callback) =>
			createIpcListener("architectureVisualizer:complete", callback),
	};
}
