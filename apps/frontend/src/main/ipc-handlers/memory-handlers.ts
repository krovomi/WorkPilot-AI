/**
 * Memory Infrastructure IPC Handlers
 *
 * Provides memory database status and validation for the Graphiti integration.
 * Uses LadybugDB (embedded Kuzu-based database) - no Docker required.
 *
 * The Ollama channels used to live here too; they are in ollama-handlers.ts.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	GraphitiConnectionTestResult,
	GraphitiValidationResult,
	InfrastructureStatus,
	IPCResult,
} from "../../shared/types";
import { validateOpenAIApiKey } from "../api-validation-service";
import {
	getDefaultDbPath,
	getMemoryService,
	getMemoryServiceStatus,
	isKuzuAvailable,
} from "../memory-service";

/**
 * Register the memory-related IPC handlers:
 * - Memory infrastructure status and management
 * - Graphiti LLM/Embedding provider validation
 *
 * @returns {void}
 */
export function registerMemoryHandlers(): void {
	// Get memory infrastructure status
	ipcMain.handle(
		IPC_CHANNELS.MEMORY_STATUS,
		async (_): Promise<IPCResult<InfrastructureStatus>> => {
			try {
				const status = getMemoryServiceStatus();
				return {
					success: true,
					data: {
						memory: status,
						ready: status.kuzuInstalled && status.databaseExists,
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to check memory status",
				};
			}
		},
	);

	// List available databases
	ipcMain.handle(
		IPC_CHANNELS.MEMORY_LIST_DATABASES,
		async (_, dbPath?: string): Promise<IPCResult<string[]>> => {
			try {
				const status = getMemoryServiceStatus(dbPath);
				return { success: true, data: status.databases };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to list databases",
				};
			}
		},
	);

	// Test memory database connection
	ipcMain.handle(
		IPC_CHANNELS.MEMORY_TEST_CONNECTION,
		async (
			_,
			dbPath?: string,
			database?: string,
		): Promise<IPCResult<GraphitiValidationResult>> => {
			try {
				if (!isKuzuAvailable()) {
					return {
						success: true,
						data: {
							success: false,
							message:
								"kuzu-node is not installed. Memory features require Python 3.12+ with LadybugDB.",
						},
					};
				}

				const service = getMemoryService({
					dbPath: dbPath || getDefaultDbPath(),
					database: database || "auto_claude_memory",
				});

				const result = await service.testConnection();
				return { success: true, data: result };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to test connection",
				};
			}
		},
	);

	// ============================================
	// Graphiti Validation Handlers
	// ============================================

	// Validate LLM provider API key (OpenAI, Anthropic, etc.)
	ipcMain.handle(
		IPC_CHANNELS.GRAPHITI_VALIDATE_LLM,
		async (
			_,
			provider: string,
			apiKey: string,
		): Promise<IPCResult<GraphitiValidationResult>> => {
			try {
				// For now, we only validate OpenAI - other providers can be added later
				if (provider === "openai") {
					const result = await validateOpenAIApiKey(apiKey);
					return { success: true, data: result };
				}

				// For other providers, do basic validation
				if (!apiKey?.trim()) {
					return {
						success: true,
						data: {
							success: false,
							message: "API key is required",
						},
					};
				}

				return {
					success: true,
					data: {
						success: true,
						message: `${provider} API key format appears valid`,
						details: { provider },
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to validate API key",
				};
			}
		},
	);

	// Test full Graphiti connection (Database + LLM provider)
	ipcMain.handle(
		IPC_CHANNELS.GRAPHITI_TEST_CONNECTION,
		async (
			_,
			config: {
				dbPath?: string;
				database?: string;
				llmProvider: string;
				apiKey: string;
			},
		): Promise<IPCResult<GraphitiConnectionTestResult>> => {
			try {
				// Test database connection
				let databaseResult: GraphitiValidationResult;

				if (!isKuzuAvailable()) {
					databaseResult = {
						success: false,
						message:
							"kuzu-node is not installed. Memory features require Python 3.12+ with LadybugDB.",
					};
				} else {
					const service = getMemoryService({
						dbPath: config.dbPath || getDefaultDbPath(),
						database: config.database || "auto_claude_memory",
					});
					databaseResult = await service.testConnection();
				}

				// Test LLM provider
				let llmResult: GraphitiValidationResult;

				if (config.llmProvider === "openai") {
					llmResult = await validateOpenAIApiKey(config.apiKey);
				} else if (config.llmProvider === "ollama") {
					// Ollama doesn't need API key validation
					llmResult = {
						success: true,
						message: "Ollama (local) does not require API key validation",
						details: { provider: "ollama" },
					};
				} else {
					// Basic validation for other providers
					llmResult = config.apiKey?.trim()
						? {
								success: true,
								message: `${config.llmProvider} API key format appears valid`,
								details: { provider: config.llmProvider },
							}
						: {
								success: false,
								message: "API key is required",
							};
				}

				return {
					success: true,
					data: {
						database: databaseResult,
						llmProvider: llmResult,
						ready: databaseResult.success && llmResult.success,
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to test Graphiti connection",
				};
			}
		},
	);
}
