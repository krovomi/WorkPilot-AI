
import { existsSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import type { IPCResult, TaskStatus } from "../../../shared/types";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { checkGitStatus } from "../../project-initializer";
import { projectStore } from "../../project-store";
import { findTaskAndProject } from "./shared";
import {
	convertTaskMetadataToSpecCreation,
	getSpecPaths,
	readPersistedSessionId,
} from "./resume-task";
import {
	type ExecutionHandlerContext,
	atomicWriteFileSync,
	checkSubtasksCompletion,
	ensureProfileManagerInitialized,
	ensureTaskEngine,
	getPlanPaths,
	requiresClaudeAuth,
	safeReadFileSync,
} from "./execution-utils";

export function registerTaskRecoveryHandlers(ctx: ExecutionHandlerContext): void {
	const { agentManager, getMainWindow } = ctx;

	/**
	 * Recover a stuck task (status says in_progress but no process running)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RECOVER_STUCK,
		async (
			_,
			taskId: string,
			options?: { targetStatus?: TaskStatus; autoRestart?: boolean },
		): Promise<
			IPCResult<{
				taskId: string;
				recovered: boolean;
				newStatus: TaskStatus;
				message: string;
				autoRestarted?: boolean;
			}>
		> => {
			const targetStatus = options?.targetStatus;
			const autoRestart = options?.autoRestart ?? false;

			// Check if task is actually running
			const isActuallyRunning = agentManager.isRunning(taskId);
			if (isActuallyRunning) {
				return createRunningTaskResponse(taskId);
			}

			// Find task and project
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Get spec directory paths
			const specPaths = getSpecPaths(task, project);
			const planPaths = getPlanPaths(specPaths, project);

			// Read and parse the plan
			const plan = await readAndParsePlan(planPaths.primary);
			if (!plan) {
				return {
					success: false,
					error: "Plan file contains invalid JSON. The file may be corrupted.",
				};
			}

			// Determine the new status
			const newStatus = determineRecoveryStatus(targetStatus, plan);

			// Update plan with new status
			updatePlanStatus(plan, newStatus);

			// Handle completed tasks differently
			if (isTaskCompleted(plan)) {
				return await handleCompletedTaskRecovery(
					taskId,
					plan,
					planPaths,
					project.id,
				);
			}

			// Reset stuck subtasks
			resetStuckSubtasks(plan);

			// Write updated plan to all locations
			const writeSuccess = await writePlanToAllLocations(plan, planPaths);
			if (!writeSuccess) {
				return {
					success: false,
					error: "Failed to write plan file during recovery",
				};
			}

			// Invalidate cache
			projectStore.invalidateTasksCache(project.id);

			// Stop file watcher
			fileWatcher.unwatch(taskId);

			// Auto-restart if requested
			const autoRestarted = await handleAutoRestart(
				autoRestart,
				task,
				project,
				taskId,
				newStatus,
				plan,
				planPaths,
			);

			// Notify renderer
			notifyRendererOfStatusChange(taskId, newStatus, project.id);

			return createSuccessResponse(taskId, newStatus, autoRestarted);
		},
	);

	/**
	 * Create response for running task
	 */
	function createRunningTaskResponse(taskId: string): IPCResult<{
		taskId: string;
		recovered: boolean;
		newStatus: TaskStatus;
		message: string;
	}> {
		return {
			success: false,
			error: "Task is still running. Stop it first before recovering.",
			data: {
				taskId,
				recovered: false,
				newStatus: "in_progress" as TaskStatus,
				message: "Task is still running",
			},
		};
	}

	/**
	 * Read and parse the plan file
	 */
	async function readAndParsePlan(
		planPath: string,
	): Promise<Record<string, unknown> | null> {
		const planContent = safeReadFileSync(planPath);
		if (!planContent) {
			return null;
		}

		try {
			return JSON.parse(planContent);
		} catch (parseError) {
			appLog.error("[Recovery] Failed to parse plan file as JSON:", parseError);
			return null;
		}
	}

	/**
	 * Determine the appropriate recovery status
	 */
	function determineRecoveryStatus(
		targetStatus: TaskStatus | undefined,
		plan: Record<string, unknown>,
	): TaskStatus {
		let newStatus: TaskStatus = targetStatus || "backlog";

		if (!targetStatus && plan.phases && Array.isArray(plan.phases)) {
			const { completedCount, totalCount, allCompleted } =
				checkSubtasksCompletion(plan);

			if (totalCount > 0) {
				if (allCompleted) {
					newStatus = "human_review";
				} else if (completedCount > 0) {
					newStatus = "in_progress";
				}
			}
		}

		return newStatus;
	}

	/**
	 * Update plan status fields
	 */
	function updatePlanStatus(
		plan: Record<string, unknown>,
		newStatus: TaskStatus,
	): void {
		plan.status = newStatus;

		// Map TaskStatus to planStatus
		let planStatus: string;
		if (newStatus === "done") {
			planStatus = "completed";
		} else if (newStatus === "in_progress") {
			planStatus = "in_progress";
		} else if (newStatus === "ai_review" || newStatus === "human_review") {
			planStatus = "review";
		} else {
			planStatus = "pending";
		}

		plan.planStatus = planStatus;
		plan.updated_at = new Date().toISOString();
		plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;
	}

	/**
	 * Check if task is completed
	 */
	function isTaskCompleted(plan: Record<string, unknown>): boolean {
		const { allCompleted } = checkSubtasksCompletion(plan);
		return allCompleted;
	}

	/**
	 * Handle recovery for completed tasks
	 */
	async function handleCompletedTaskRecovery(
		taskId: string,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
		projectId: string,
	): Promise<
		IPCResult<{
			taskId: string;
			recovered: boolean;
			newStatus: TaskStatus;
			message: string;
			autoRestarted?: boolean;
		}>
	> {
		appLog.info(
			"[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart",
		);

		plan.status = "human_review";
		plan.planStatus = "review";

		const planContent = JSON.stringify(plan, null, 2);
		const writeSuccess = await writePlanContentToAllLocations(
			planContent,
			planPaths.all,
		);

		if (!writeSuccess) {
			return {
				success: false,
				error:
					"Failed to write plan file during recovery (all locations failed)",
			};
		}

		projectStore.invalidateTasksCache(projectId);

		return {
			success: true,
			data: {
				taskId,
				recovered: true,
				newStatus: "human_review",
				message: "Task is complete and ready for review",
				autoRestarted: false,
			},
		};
	}

	/**
	 * Reset stuck subtasks to pending
	 */
	function resetStuckSubtasks(plan: Record<string, unknown>): void {
		if (plan.phases && Array.isArray(plan.phases)) {
			for (const phase of plan.phases as Array<{
				subtasks?: Array<{
					status: string;
					actual_output?: string;
					started_at?: string;
					completed_at?: string;
				}>;
			}>) {
				if (phase.subtasks && Array.isArray(phase.subtasks)) {
					for (const subtask of phase.subtasks) {
						// An in_progress subtask is left alone: it is the one the
						// dead process was on, and the backend reopens it at start
						// (reopen_interrupted_subtasks) keeping what it recorded, so
						// the next session continues it instead of starting it over.
						// Reset failed subtasks to pending
						if (subtask.status === "failed") {
							resetSubtask(subtask, "failed");
						}
					}
				}
			}
		}
	}

	/**
	 * Reset a single subtask
	 */
	function resetSubtask(
		subtask: {
			status: string;
			actual_output?: string;
			started_at?: string;
			completed_at?: string;
		},
		originalStatus: string,
	): void {
		subtask.status = "pending";
		delete subtask.actual_output;
		delete subtask.started_at;
		delete subtask.completed_at;
		appLog.info(`[Recovery] Reset ${originalStatus} subtask to pending`);
	}

	/**
	 * Write plan to all locations
	 */
	async function writePlanToAllLocations(
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		const planContent = JSON.stringify(plan, null, 2);
		return await writePlanContentToAllLocations(planContent, planPaths.all);
	}

	/**
	 * Write plan content to all locations
	 */
	async function writePlanContentToAllLocations(
		planContent: string,
		planPaths: string[],
	): Promise<boolean> {
		let writeSucceeded = false;
		for (const pathToUpdate of planPaths) {
			try {
				atomicWriteFileSync(pathToUpdate, planContent);
				appLog.info(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
				writeSucceeded = true;
			} catch (writeError) {
				appLog.error(
					`[Recovery] Failed to write plan file at ${pathToUpdate}:`,
					writeError,
				);
			}
		}
		return writeSucceeded;
	}

	/**
	 * Handle auto-restart if requested
	 */
	async function handleAutoRestart(
		autoRestart: boolean,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		task: any,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		project: any,
		taskId: string,
		newStatus: TaskStatus,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		if (!autoRestart) {
			return false;
		}

		// Check git status
		const gitStatus = checkGitStatus(project.path);
		if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
			console.warn("[Recovery] Git check failed, cannot auto-restart task");
			return false;
		}

		// Check authentication
		const initResult = await ensureProfileManagerInitialized();
		if (!initResult.success) {
			console.warn(
				"[Recovery] Profile manager initialization failed, cannot auto-restart task",
			);
			return false;
		}

		const profileManager = initResult.profileManager;
		if (requiresClaudeAuth(task, project) && !profileManager.hasValidAuth()) {
			console.warn("[Recovery] Auth check failed, cannot auto-restart task");
			return false;
		}

		// Perform the restart
		return await performTaskRestart(
			task,
			project,
			taskId,
			newStatus,
			plan,
			planPaths,
		);
	}

	/**
	 * Perform the actual task restart
	 */
	async function performTaskRestart(
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		task: any,
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		project: any,
		taskId: string,
		_newStatus: TaskStatus,
		plan: Record<string, unknown>,
		planPaths: ReturnType<typeof getPlanPaths>,
	): Promise<boolean> {
		try {
			// Update plan status for restart
			plan.status = "in_progress";
			plan.planStatus = "in_progress";
			const restartPlanContent = JSON.stringify(plan, null, 2);

			for (const pathToUpdate of planPaths.all) {
				try {
					atomicWriteFileSync(pathToUpdate, restartPlanContent);
					appLog.info(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
				} catch (writeError) {
					appLog.error(
						`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`,
						writeError,
					);
				}
			}

			projectStore.invalidateTasksCache(project.id);

			// Start file watcher
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDirForWatcher = path.join(
				project.path,
				specsBaseDir,
				task.specId,
			);
			fileWatcher.watch(taskId, specDirForWatcher);

			// Check if spec exists
			const specFilePath = path.join(
				specDirForWatcher,
				AUTO_BUILD_PATHS.SPEC_FILE,
			);
			const hasSpec = existsSync(specFilePath);
			const needsSpecCreation = !hasSpec;

			// The task runs on its own engine, never the default provider's.
			ensureTaskEngine(task, project, specDirForWatcher);

			const baseBranch =
				task.metadata?.baseBranch || project.settings?.mainBranch;

			// Start the task
			if (needsSpecCreation) {
				const taskDescription = task.description || task.title;
				console.warn(`[Recovery] Starting spec creation for: ${task.specId}`);
				agentManager.startSpecCreation(
					taskId,
					project.path,
					taskDescription,
					specDirForWatcher,
					convertTaskMetadataToSpecCreation(task.metadata),
					baseBranch,
					project.id,
				);
			} else {
				console.warn(`[Recovery] Starting task execution for: ${task.specId}`);
				agentManager.startTaskExecution(
					taskId,
					project.path,
					task.specId,
					{
						parallel: false,
						workers: 1,
						baseBranch,
						useWorktree: task.metadata?.useWorktree,
						useLocalBranch: task.metadata?.useLocalBranch,
						tddMode: task.metadata?.tddMode,
						verifyLoop: task.metadata?.verifyLoop,
						mobileTargets: task.metadata?.mobileTargets,
						// A stuck task is one whose process died mid-session: pick
						// that session back up, as a resume does.
						resumeSessionId: readPersistedSessionId(specDirForWatcher),
					},
					project.id,
				);
			}

			console.warn(`[Recovery] Auto-restarted task ${taskId}`);
			return true;
		} catch (restartError) {
			appLog.error("Failed to auto-restart task after recovery:", restartError);
			return false;
		}
	}

	/**
	 * Notify renderer of status change
	 */
	function notifyRendererOfStatusChange(
		taskId: string,
		newStatus: TaskStatus,
		projectId: string,
	): void {
		const mainWindow = getMainWindow();
		if (mainWindow) {
			mainWindow.webContents.send(
				IPC_CHANNELS.TASK_STATUS_CHANGE,
				taskId,
				newStatus,
				projectId,
			);
		}
	}

	/**
	 * Create success response
	 */
	function createSuccessResponse(
		taskId: string,
		newStatus: TaskStatus,
		autoRestarted: boolean,
	): IPCResult<{
		taskId: string;
		recovered: boolean;
		newStatus: TaskStatus;
		message: string;
		autoRestarted?: boolean;
	}> {
		return {
			success: true,
			data: {
				taskId,
				recovered: true,
				newStatus,
				message: autoRestarted
					? "Task recovered and restarted successfully"
					: `Task recovered successfully and moved to ${newStatus}`,
				autoRestarted,
			},
		};
	}
}
