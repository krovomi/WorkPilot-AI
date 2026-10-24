import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { testGenerationService } from "../test-generation-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Setup IPC handlers for test generation functionality.
 * Call this once when the app initialises.
 */
export function setupTestGenerationHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// Forward service events to renderer
	testGenerationService.on("status", (status: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_STATUS, status);
		}
	});

	// Forwarded as-is: the service already produced the structured payload the
	// renderer renders (message, code, stage, redacted details).
	testGenerationService.on("error", (error: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_ERROR, error);
		}
	});

	testGenerationService.on("result", (result: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_RESULT, result);
		}
	});

	testGenerationService.on("complete", (result: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_COMPLETE, result);
		}
	});

	// Live pipeline stage events (detect/read/generate/write/done)
	testGenerationService.on("progress", (event: unknown) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_PROGRESS, event);
		}
	});

	// Streamed chunks of clean generated test code
	testGenerationService.on("code", (delta: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.TEST_GENERATION_CODE, delta);
		}
	});

	// Analyze test coverage
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_ANALYZE_COVERAGE,
		async (
			_,
			params: {
				filePath: string;
				existingTestPath?: string;
				projectPath?: string;
			},
		) => {
			try {
				await testGenerationService.analyzeCoverage(
					params.filePath,
					params.existingTestPath,
					params.projectPath,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] analyze-coverage error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Where would the generated tests be written? Answered before a generation
	// starts, so the UI can ask the user when the project has no test directory
	// instead of dropping the file next to the solution file.
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_RESOLVE_DESTINATION,
		async (
			_,
			params: {
				filePath: string;
				projectPath?: string;
				existingTestPath?: string;
			},
		) => {
			try {
				const destination = await testGenerationService.resolveDestination(
					params.filePath,
					params.projectPath,
					params.existingTestPath,
				);
				return { success: true, destination };
			} catch (error) {
				console.error("[TestGeneration] resolve-destination error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// What will these tests be written against? Answered before a generation so
	// the picker opens with the project's own stack ticked.
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_RESOLVE_LIBRARIES,
		async (
			_,
			params: {
				filePath?: string;
				projectPath?: string;
				selected?: string[];
			},
		) => {
			try {
				const libraries = await testGenerationService.resolveLibraries(
					params.filePath ?? "",
					params.projectPath,
					params.selected,
				);
				return { success: true, libraries };
			} catch (error) {
				console.error("[TestGeneration] resolve-libraries error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Add the chosen-but-absent packages to the project's test project. Only
	// ever reached from an explicit user action — a generation installs nothing.
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_ADD_PACKAGES,
		async (
			_,
			params: {
				selected: string[];
				projectPath: string;
				testDir?: string;
				filePath?: string;
			},
		) => {
			try {
				const report = await testGenerationService.addPackages(
					params.selected,
					params.projectPath,
					params.testDir,
					params.filePath,
				);
				return { success: true, report };
			} catch (error) {
				console.error("[TestGeneration] add-packages error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate unit tests
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_GENERATE_UNIT,
		async (
			_,
			params: {
				filePath: string;
				existingTestPath?: string;
				coverageTarget?: number;
				projectPath?: string;
				testDir?: string;
				testLibraries?: string[];
			},
		) => {
			try {
				await testGenerationService.generateUnitTests(
					params.filePath,
					params.existingTestPath,
					params.coverageTarget,
					params.projectPath,
					params.testDir,
					params.testLibraries,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-unit error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate E2E tests
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_GENERATE_E2E,
		async (
			_,
			params: {
				userStory: string;
				targetModule: string;
				projectPath?: string;
				testDir?: string;
				testLibraries?: string[];
			},
		) => {
			try {
				await testGenerationService.generateE2ETests(
					params.userStory,
					params.targetModule,
					params.projectPath,
					params.testDir,
					params.testLibraries,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-e2e error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Generate TDD tests
	ipcMain.handle(
		IPC_CHANNELS.TEST_GENERATION_GENERATE_TDD,
		async (
			_,
			params: {
				description: string;
				language: string;
				snippetType: string;
				projectPath?: string;
				testDir?: string;
				testLibraries?: string[];
			},
		) => {
			try {
				await testGenerationService.generateTDDTests(
					params.description,
					params.language,
					params.snippetType,
					params.projectPath,
					params.testDir,
					params.testLibraries,
				);
				return { success: true };
			} catch (error) {
				console.error("[TestGeneration] generate-tdd error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Cancel active generation
	ipcMain.handle(IPC_CHANNELS.TEST_GENERATION_CANCEL, async () => {
		try {
			const cancelled = testGenerationService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			console.error("[TestGeneration] cancel error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
}

/**
 * Cleanup IPC handlers for test generation.
 * Call this during app shutdown.
 */
export function cleanupTestGenerationHandlers(): void {
	ipcMain.removeHandler("test-generation:analyze-coverage");
	ipcMain.removeHandler("test-generation:resolve-destination");
	ipcMain.removeHandler("test-generation:resolve-libraries");
	ipcMain.removeHandler("test-generation:add-packages");
	ipcMain.removeHandler("test-generation:generate-unit");
	ipcMain.removeHandler("test-generation:generate-e2e");
	ipcMain.removeHandler("test-generation:generate-tdd");
	ipcMain.removeHandler("test-generation:cancel");

	testGenerationService.removeAllListeners();
	testGenerationService.cancel();
}
