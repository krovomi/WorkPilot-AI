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
import type { ArchitectureVisualizerResult } from "../../../main/architecture-visualizer-service";
export type { ArchitectureVisualizerResult };

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
