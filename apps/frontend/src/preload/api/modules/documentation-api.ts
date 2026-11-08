/**
 * Documentation API: the Documentation tab's bridge to
 * runners/documentation_runner.py (see documentation-handlers.ts).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	DocumentationAction,
	DocumentationRequest,
	DocumentationResultMap,
} from "../../../shared/types/documentation";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface DocumentationAPI {
	runDocumentation: <A extends DocumentationAction>(
		request: DocumentationRequest & { action: A },
	) => Promise<DocumentationResultMap[A]>;
	cancelDocumentation: () => Promise<boolean>;
	onDocumentationProgress: (callback: (status: string) => void) => () => void;
}

export const createDocumentationAPI = (): DocumentationAPI => ({
	runDocumentation: (request) => invokeIpc(IPC_CHANNELS.DOCUMENTATION_RUN, request),
	cancelDocumentation: () => invokeIpc<boolean>(IPC_CHANNELS.DOCUMENTATION_CANCEL),
	onDocumentationProgress: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.DOCUMENTATION_PROGRESS, (status) =>
			callback(status),
		),
});
