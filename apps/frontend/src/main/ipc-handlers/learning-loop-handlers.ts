/**
 * Learning Loop IPC handlers registration
 *
 * Handles IPC communication between the renderer process and the
 * Learning Loop backend service for pattern management and analysis.
 */

import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { learningLoopService } from "../learning-loop-service";
import { backendFetch } from "./_backend-fetch";
import { safeSendToRenderer } from "./utils";

interface LearningPatternsResponse {
	patterns?: unknown[];
	summary?: Record<string, unknown>;
}

function fetchLearningPatterns(projectDir: string) {
	const query = new URLSearchParams({ project_dir: projectDir });
	return backendFetch<LearningPatternsResponse>(
		`/api/brain/learning-patterns?${query.toString()}`,
		{ method: "GET" },
		15_000,
	);
}

function postJson(body: Record<string, string>): RequestInit {
	// No headers here: backendFetch sets the JSON content type and the
	// server-mode Authorization header, and an `init.headers` would replace them.
	return { method: "POST", body: JSON.stringify(body) };
}

/**
 * Register all learning-loop-related IPC handlers
 */
export function registerLearningLoopHandlers(
	getMainWindow: () => BrowserWindow | null,
): () => void {
	// ============================================
	// Pattern CRUD operations (invoke/handle)
	// ============================================

	// The patterns are notes of the project's memory in the shared brain
	// (`learning_loop/pattern_storage.py`); the backend reads and writes them.
	// These handlers used to open `.workpilot/learning_loop/patterns.json`
	// themselves, expecting `{ patterns: [...] }` where the backend wrote a
	// bare list — so the page showed nothing, whatever the loop had learned.

	ipcMain.handle(
		IPC_CHANNELS.LEARNING_LOOP_GET_PATTERNS,
		async (_event, projectDir: string) => {
			const result = await fetchLearningPatterns(projectDir);
			return result.success
				? { success: true, data: result.patterns ?? [] }
				: { success: false, error: result.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.LEARNING_LOOP_GET_SUMMARY,
		async (_event, projectDir: string) => {
			const result = await fetchLearningPatterns(projectDir);
			return result.success
				? { success: true, data: result.summary }
				: { success: false, error: result.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.LEARNING_LOOP_DELETE_PATTERN,
		async (_event, projectDir: string, patternId: string) => {
			const result = await backendFetch(
				"/api/brain/learning-patterns/delete",
				postJson({ project_dir: projectDir, pattern_id: patternId }),
			);
			return result.success
				? { success: true }
				: { success: false, error: result.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.LEARNING_LOOP_TOGGLE_PATTERN,
		async (_event, projectDir: string, patternId: string) => {
			const result = await backendFetch<{ enabled: boolean }>(
				"/api/brain/learning-patterns/toggle",
				postJson({ project_dir: projectDir, pattern_id: patternId }),
			);
			return result.success
				? { success: true, data: result.enabled }
				: { success: false, error: result.error };
		},
	);

	// ============================================
	// Analysis operations (send/on for streaming)
	// ============================================

	ipcMain.on(
		IPC_CHANNELS.LEARNING_LOOP_RUN_ANALYSIS,
		(_event, projectDir: string, specId?: string) => {
			learningLoopService.analyze({
				projectDir,
				specId,
			});
		},
	);

	ipcMain.handle(IPC_CHANNELS.LEARNING_LOOP_STOP_ANALYSIS, () => {
		const cancelled = learningLoopService.cancel();
		return { success: true, cancelled };
	});

	// ============================================
	// Learning Loop Service Events → Renderer
	// ============================================

	const handleStatus = (status: string): void => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.LEARNING_LOOP_STATUS,
			status,
		);
	};

	const handleStreamChunk = (chunk: string): void => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.LEARNING_LOOP_STREAM_CHUNK,
			chunk,
		);
	};

	const handleError = (error: string): void => {
		safeSendToRenderer(getMainWindow, IPC_CHANNELS.LEARNING_LOOP_ERROR, error);
	};

	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	const handleComplete = (result: any): void => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.LEARNING_LOOP_COMPLETE,
			result,
		);
	};

	learningLoopService.on("status", handleStatus);
	learningLoopService.on("stream-chunk", handleStreamChunk);
	learningLoopService.on("error", handleError);
	learningLoopService.on("complete", handleComplete);

	// Return cleanup function
	return (): void => {
		learningLoopService.off("status", handleStatus);
		learningLoopService.off("stream-chunk", handleStreamChunk);
		learningLoopService.off("error", handleError);
		learningLoopService.off("complete", handleComplete);
	};
}
