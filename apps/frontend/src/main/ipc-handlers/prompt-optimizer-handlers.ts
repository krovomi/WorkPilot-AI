import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	PromptOptimizerAgentType,
	PromptOptimizerError,
	PromptOptimizerResult,
	PromptOptimizerStatus,
} from "../../shared/types/prompt-optimizer";
import { debugError } from "../../shared/utils/debug-logger";
import { projectStore } from "../project-store";
import {
	PROMPT_OPTIMIZER_RUNNER,
	promptOptimizerService,
} from "../prompt-optimizer-service";
import { getConfiguredPythonPath } from "../python-env-manager";
import { getPageFeatureSettings } from "../services/page-llm-config";
import { getEffectiveSourcePath } from "../updater/path-resolver";
import { getRunnerEnv } from "./github/utils/runner-env";
import { safeSendToRenderer } from "./utils";

/**
 * Register all prompt optimizer IPC handlers
 */
export function registerPromptOptimizerHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	const sendError = (error: PromptOptimizerError) =>
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.PROMPT_OPTIMIZER_ERROR,
			error,
		);

	/**
	 * Receives: projectId, prompt, agentType. Fire and forget — results come
	 * back via events.
	 *
	 * The backend is found the way every other runner finds it
	 * (`getEffectiveSourcePath`: settings, then the updated copy, then the
	 * bundled one). This handler used to guess `userData/../auto-claude` and
	 * `cwd/apps/backend`, neither of which exists in a packaged app.
	 */
	ipcMain.on(
		IPC_CHANNELS.PROMPT_OPTIMIZER_OPTIMIZE,
		async (
			_,
			projectId: string,
			prompt: string,
			agentType: PromptOptimizerAgentType,
		) => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				sendError({ code: "project_not_found", message: projectId });
				return;
			}

			const backendPath = getEffectiveSourcePath();
			if (!existsSync(path.join(backendPath, PROMPT_OPTIMIZER_RUNNER))) {
				sendError({
					code: "runner_missing",
					message: path.join(backendPath, PROMPT_OPTIMIZER_RUNNER),
				});
				return;
			}

			const pythonPath = getConfiguredPythonPath();
			if (!pythonPath) {
				sendError({ code: "python_missing", message: "" });
				return;
			}

			try {
				// Claude's own chain (OAuth profile, API profile) and the page's
				// provider with its key — the same assembly every runner receives.
				const env = await getRunnerEnv({}, { page: "prompt-optimizer" });
				const featureSettings = getPageFeatureSettings("prompt-optimizer");

				promptOptimizerService.optimize(
					{
						projectDir: project.path,
						prompt,
						agentType,
						model: featureSettings.model,
						thinkingLevel: featureSettings.thinkingLevel,
					},
					{ pythonPath, backendPath, env },
				);
			} catch (error) {
				debugError("[PromptOptimizer Handler] Optimization error:", error);
				sendError({
					code: "spawn_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	ipcMain.on(IPC_CHANNELS.PROMPT_OPTIMIZER_CANCEL, () => {
		promptOptimizerService.cancel();
	});

	// ============================================
	// Event Forwarding (Service -> Renderer)
	// ============================================

	promptOptimizerService.on("stream-chunk", (chunk: string) => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.PROMPT_OPTIMIZER_STREAM_CHUNK,
			chunk,
		);
	});

	promptOptimizerService.on("status", (status: PromptOptimizerStatus) => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.PROMPT_OPTIMIZER_STATUS,
			status,
		);
	});

	promptOptimizerService.on("error", (error: PromptOptimizerError) => {
		sendError(error);
	});

	promptOptimizerService.on("complete", (result: PromptOptimizerResult) => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.PROMPT_OPTIMIZER_COMPLETE,
			result,
		);
	});
}
