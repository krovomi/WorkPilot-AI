/**
 * Documentation Agent API module
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface DocumentationAgentRequest {
	projectDir: string;
	docTypes?: string[];
	outputDir?: string;
	insertInline?: boolean;
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
import type { DocumentationAgentResult } from "../../../main/documentation-agent-service";
export type { DocumentationAgentResult };

export interface DocumentationAgentAPI {
	generateDocumentation: (
		request: DocumentationAgentRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelDocumentation: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	configureDocumentationAgent: (config: {
		pythonPath?: string;
	}) => Promise<{ success: boolean; error?: string }>;
	onDocumentationAgentStatus: (
		callback: (status: string) => void,
	) => () => void;
	onDocumentationAgentStreamChunk: (
		callback: (chunk: string) => void,
	) => () => void;
	onDocumentationAgentError: (callback: (error: string) => void) => () => void;
	onDocumentationAgentComplete: (
		callback: (result: DocumentationAgentResult) => void,
	) => () => void;
}

export function createDocumentationAgentAPI(): DocumentationAgentAPI {
	return {
		generateDocumentation: (request) =>
			invokeIpc("documentationAgent:generate", request),
		cancelDocumentation: () =>
			invokeIpc("documentationAgent:cancel"),
		configureDocumentationAgent: (config) =>
			invokeIpc("documentationAgent:configure", config),
		onDocumentationAgentStatus: (callback) =>
			createIpcListener("documentationAgent:status", callback),
		onDocumentationAgentStreamChunk: (callback) =>
			createIpcListener("documentationAgent:streamChunk", callback),
		onDocumentationAgentError: (callback) =>
			createIpcListener("documentationAgent:error", callback),
		onDocumentationAgentComplete: (callback) =>
			createIpcListener("documentationAgent:complete", callback),
	};
}
