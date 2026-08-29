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

export interface DocumentationAgentResult {
	doc_types_generated: string[];
	files_created: string[];
	outdated_docs_updated?: string[];
	coverage_before?: { overall_coverage: number };
	coverage_after?: { overall_coverage: number };
}

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
