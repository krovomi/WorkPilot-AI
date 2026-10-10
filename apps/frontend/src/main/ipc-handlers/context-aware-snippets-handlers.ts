import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import {
	type ContextAwareSnippetRequest,
	type ContextAwareSnippetResult,
	type ContextAwareSnippetsError,
	type ContextAwareSnippetsStartResult,
	type ContextAwareSnippetsStatus,
	SNIPPET_TYPES,
} from "../../shared/types/context-aware-snippets";
import { debugError } from "../../shared/utils/debug-logger";
import {
	CONTEXT_AWARE_SNIPPETS_RUNNER,
	contextAwareSnippetsService,
} from "../context-aware-snippets-service";
import { projectStore } from "../project-store";
import { getConfiguredPythonPath } from "../python-env-manager";
import { getEffectiveSourcePath } from "../updater/path-resolver";
import { getRunnerEnv } from "./github/utils/runner-env";
import { safeSendToRenderer } from "./utils";

const refuse = (
	code: string,
	message = "",
): ContextAwareSnippetsStartResult => ({
	success: false,
	error: { code, message },
});

/**
 * Register the context-aware snippets IPC handlers.
 *
 * This module used to export `setupContextAwareSnippetsHandlers`, which
 * nothing called: every generation was an `invoke` on an unregistered
 * channel, and the four events the renderer listened to were never sent.
 */
export function registerContextAwareSnippetsHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// The latest generation asked for. Building the runner's environment is
	// async (the GitHub token is fetched fresh), so a cancel — or a newer
	// request — can arrive before anything has been spawned; a request that is
	// no longer the latest once the environment is ready is dropped.
	let latestRequest = 0;

	/**
	 * Receives the project by id, never a path: the main process resolves its
	 * own checkout. The dialog used to send the id as `--project-dir`.
	 *
	 * Answers whether the run started; everything after that — status,
	 * streamed text, result or failure — comes back as events.
	 */
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_GENERATE,
		async (
			_,
			request: ContextAwareSnippetRequest,
		): Promise<ContextAwareSnippetsStartResult> => {
			const ticket = ++latestRequest;

			if (
				!request ||
				typeof request.projectId !== "string" ||
				typeof request.description !== "string" ||
				!request.description.trim() ||
				!SNIPPET_TYPES.includes(request.snippetType) ||
				(request.language !== undefined &&
					typeof request.language !== "string")
			) {
				return refuse("invalid_input");
			}

			const project = projectStore.getProject(request.projectId);
			if (!project) {
				return refuse("project_not_found", request.projectId);
			}

			// Found the way every other runner finds it: settings, then the
			// updated copy, then the bundled one. The service used to guess
			// `userData/../auto-claude` and `cwd/apps/backend`.
			const backendPath = getEffectiveSourcePath();
			const runnerPath = path.join(backendPath, CONTEXT_AWARE_SNIPPETS_RUNNER);
			if (!existsSync(runnerPath)) {
				return refuse("runner_missing", runnerPath);
			}

			const pythonPath = getConfiguredPythonPath();
			if (!pythonPath) {
				return refuse("python_missing");
			}

			try {
				// Claude's own chain (OAuth profile, API profile) and the default
				// provider with its key. No page of its own: the feature has no
				// per-page model selector, so the global choice applies.
				const env = await getRunnerEnv({});
				if (ticket !== latestRequest) return { success: true };

				contextAwareSnippetsService.generate(
					{
						projectDir: project.path,
						snippetType: request.snippetType,
						description: request.description,
						language: request.language?.trim() || undefined,
					},
					{ pythonPath, backendPath, env },
				);
				return { success: true };
			} catch (error) {
				debugError("[ContextAwareSnippets Handler] Generation error:", error);
				return refuse(
					"spawn_failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	);

	ipcMain.handle(IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_CANCEL, () => {
		latestRequest++;
		return { success: true, cancelled: contextAwareSnippetsService.cancel() };
	});

	// ============================================
	// Event Forwarding (Service -> Renderer)
	// ============================================

	contextAwareSnippetsService.on("stream-chunk", (chunk: string) => {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_STREAM_CHUNK,
			chunk,
		);
	});

	contextAwareSnippetsService.on(
		"status",
		(status: ContextAwareSnippetsStatus) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_STATUS,
				status,
			);
		},
	);

	contextAwareSnippetsService.on(
		"error",
		(error: ContextAwareSnippetsError) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_ERROR,
				error,
			);
		},
	);

	contextAwareSnippetsService.on(
		"complete",
		(result: ContextAwareSnippetResult) => {
			safeSendToRenderer(
				getMainWindow,
				IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_COMPLETE,
				result,
			);
		},
	);
}
