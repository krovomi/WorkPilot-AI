/**
 * Worktree recipe IPC handlers: show a project's recipe, approve its
 * `.workpilot/worktree.toml`, or save the detected one
 * (`apps/backend/core/workspace/recipe_api.py`). The project directory is
 * argument 0, checked by the path policy (`security/ipc-path-policy.ts`).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
	WorktreeRecipeResult,
	WorktreeRecipeState,
} from "../../shared/types/worktree-recipe";
import { type BackendResult, backendFetch } from "./_backend-fetch";

function toResult(
	result: BackendResult<WorktreeRecipeState>,
): WorktreeRecipeResult {
	if (!result.success) return { success: false, error: result.error };
	const { recipe, detected, hasFile, approved } = result;
	return { success: true, data: { recipe, detected, hasFile, approved } };
}

function post(path: string, projectDir: string) {
	// No headers: backendFetch sets the JSON content type.
	return backendFetch<WorktreeRecipeState>(path, {
		method: "POST",
		body: JSON.stringify({ project_dir: projectDir }),
	});
}

export function registerWorktreeRecipeHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.WORKTREE_RECIPE_GET,
		async (_event, projectDir: string): Promise<WorktreeRecipeResult> => {
			const query = new URLSearchParams({ project_dir: projectDir });
			return toResult(
				await backendFetch<WorktreeRecipeState>(
					`/api/worktree-recipe?${query.toString()}`,
					{ method: "GET" },
					15_000,
				),
			);
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.WORKTREE_RECIPE_APPROVE,
		async (_event, projectDir: string): Promise<WorktreeRecipeResult> =>
			toResult(await post("/api/worktree-recipe/approve", projectDir)),
	);

	ipcMain.handle(
		IPC_CHANNELS.WORKTREE_RECIPE_SAVE_DETECTED,
		async (_event, projectDir: string): Promise<WorktreeRecipeResult> =>
			toResult(await post("/api/worktree-recipe/save-detected", projectDir)),
	);
}
