/**
 * Worktree recipe API module: what a new task worktree runs before the first session.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { WorktreeRecipeResult } from "../../../shared/types/worktree-recipe";
import { invokeIpc } from "./ipc-utils";

export interface WorktreeRecipeAPI {
	getWorktreeRecipe: (projectDir: string) => Promise<WorktreeRecipeResult>;
	approveWorktreeRecipe: (projectDir: string) => Promise<WorktreeRecipeResult>;
	saveDetectedWorktreeRecipe: (
		projectDir: string,
	) => Promise<WorktreeRecipeResult>;
}

export function createWorktreeRecipeAPI(): WorktreeRecipeAPI {
	return {
		getWorktreeRecipe: (projectDir: string) =>
			invokeIpc(IPC_CHANNELS.WORKTREE_RECIPE_GET, projectDir),
		approveWorktreeRecipe: (projectDir: string) =>
			invokeIpc(IPC_CHANNELS.WORKTREE_RECIPE_APPROVE, projectDir),
		saveDetectedWorktreeRecipe: (projectDir: string) =>
			invokeIpc(IPC_CHANNELS.WORKTREE_RECIPE_SAVE_DETECTED, projectDir),
	};
}
