/**
 * The QA review of a green card run again on this machine, after its branch
 * took a new base and the project has no CI to run the suite (lot F). The
 * same steps as moving the card to « AI review » from the board.
 */

import path from "node:path";
import type { BrowserWindow } from "electron";
import { getSpecsDir, IPC_CHANNELS } from "../../shared/constants";
import type { Project, Task } from "../../shared/types";
import type { AgentManager } from "../agent";
import { fileWatcher } from "../file-watcher";
import {
	ensureProfileManagerInitialized,
	ensureTaskEngine,
	requiresClaudeAuth,
} from "../ipc-handlers/task/execution-utils";
import { getPlanPath, persistPlanStatus } from "../ipc-handlers/task/plan-file-utils";
import { projectStore } from "../project-store";
import { taskStateManager } from "../task-state-manager";

export async function rerunQaReview(
	task: Task,
	project: Project,
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): Promise<boolean> {
	if (agentManager.isRunning(task.id)) return false;
	const profiles = await ensureProfileManagerInitialized();
	if (!profiles.success) return false;
	if (requiresClaudeAuth(task, project) && !profiles.profileManager.hasValidAuth()) {
		console.warn(`[BaseRefresh] ${task.specId}: QA not restarted, the provider needs a sign-in`);
		return false;
	}
	if (
		!taskStateManager.handleManualStatusChange(
			task.id,
			"ai_review",
			task,
			project,
			"system",
		)
	) {
		await persistPlanStatus(
			getPlanPath(project, task),
			"ai_review",
			project.id,
			"system",
		);
	}
	const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
	fileWatcher.watch(task.id, specDir);
	ensureTaskEngine(task, project, specDir);
	await agentManager.startQAProcess(task.id, project.path, task.specId, project.id);
	projectStore.invalidateTasksCache(project.id);
	getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_STATUS_CHANGE, task.id, "ai_review", project.id);
	return true;
}
