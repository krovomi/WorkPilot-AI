/**
 * Code Migration Agent API module
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface CodeMigrationRequest {
	projectDir: string;
	migrationDescription: string;
	dryRun?: boolean;
	batchSize?: number;
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
import type { CodeMigrationResult } from "../../../main/code-migration-service";
export type { CodeMigrationResult };

export interface CodeMigrationAPI {
	startCodeMigration: (
		request: CodeMigrationRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelCodeMigration: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;
	configureCodeMigration: (config: {
		pythonPath?: string;
	}) => Promise<{ success: boolean; error?: string }>;
	onCodeMigrationStatus: (callback: (status: string) => void) => () => void;
	onCodeMigrationStreamChunk: (callback: (chunk: string) => void) => () => void;
	onCodeMigrationError: (callback: (error: string) => void) => () => void;
	onCodeMigrationComplete: (
		callback: (result: CodeMigrationResult) => void,
	) => () => void;
	onCodeMigrationTaskProgress: (
		callback: (progress: {
			current: number;
			total: number;
			file: string;
		}) => void,
	) => () => void;
}

export function createCodeMigrationAPI(): CodeMigrationAPI {
	return {
		startCodeMigration: (request) =>
			invokeIpc("codeMigration:start", request),
		cancelCodeMigration: () =>
			invokeIpc("codeMigration:cancel"),
		configureCodeMigration: (config) =>
			invokeIpc("codeMigration:configure", config),
		onCodeMigrationStatus: (callback) =>
			createIpcListener("codeMigration:status", callback),
		onCodeMigrationStreamChunk: (callback) =>
			createIpcListener("codeMigration:streamChunk", callback),
		onCodeMigrationError: (callback) =>
			createIpcListener("codeMigration:error", callback),
		onCodeMigrationComplete: (callback) =>
			createIpcListener("codeMigration:complete", callback),
		onCodeMigrationTaskProgress: (callback) =>
			createIpcListener("codeMigration:taskProgress", callback),
	};
}
