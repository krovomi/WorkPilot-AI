
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import type { TaskEvent } from "../../../shared/state-machines/task-machine";
import type {
	IPCResult,
	Project,
	Task,
	TaskStartOptions,
} from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { recordTaskLauncher } from "../../task-run-facts";
import { taskStateManager } from "../../task-state-manager";
import { parsePlanEdit } from "./plan-edit";
import { getPlanPath, updatePlanSubtasks } from "./plan-file-utils";
import {
	clearPauseState,
} from "./pause-state-utils";
import { registerPauseHandler } from "./pause-task";
import { findTaskAndProject } from "./shared";
import {
	allSpecDirs,
	convertTaskMetadataToSpecCreation,
	getSpecPaths,
	resumePausedTask,
} from "./resume-task";

import {
	type ExecutionHandlerContext,
	checkSubtasksCompletion,
	determineStartEvent,
	ensureTaskEngine,
	getPlanPaths,
	safeReadFileSync,
	setupTaskExecution,
	validateTaskPrerequisites,
} from "./execution-utils";
import { registerTaskReviewHandlers } from "./execution-review-handlers";
import {
	findServerCard,
	startServerCard,
	stopServerCard,
} from "../../server-board-actions";
import { registerTaskStatusHandlers } from "./execution-status-handlers";
import { registerTaskResumeHandlers } from "./execution-resume-handlers";
import { registerTaskRecoveryHandlers } from "./execution-recovery-handlers";
import { registerSubtaskUnblockHandlers } from "./subtask-unblock-handlers";
import { splitStackError, stackSplitPartBeforeStart } from "./split-stack";

/** Starting and stopping a task from the main process, as the board does. */
export interface TaskControl {
	/** `false` when the task could not start (the board was told why). */
	start(taskId: string, options?: TaskStartOptions): Promise<boolean>;
	stop(taskId: string): void;
	/** Whether the task's agents are running now. */
	isRunning(taskId: string): boolean;
}

let taskControl: TaskControl | null = null;

/** Set once the task handlers are registered; `null` before. */
export function getTaskControl(): TaskControl | null {
	return taskControl;
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Start the appropriate task execution based on needs
	 */
	function startTaskExecution(
		taskId: string,
		task: Task,
		project: Project,
		specDir: string,
		needsSpecCreation: boolean,
		needsImplementation: boolean,
		options?: TaskStartOptions,
	): void {
		const baseBranch =
			task.metadata?.baseBranch || project.settings?.mainBranch;
		const taskDescription = task.description || task.title;

		if (needsSpecCreation) {
			console.warn(
				"[TASK_START] Starting spec creation for:",
				task.specId,
				"in:",
				specDir,
				"baseBranch:",
				baseBranch,
			);
			agentManager.startSpecCreation(
				taskId,
				project.path,
				taskDescription,
				specDir,
				convertTaskMetadataToSpecCreation(task.metadata),
				baseBranch,
				project.id,
			);
			return;
		}

		const executionOptions = {
			parallel: false,
			workers: 1,
			baseBranch,
			useWorktree: task.metadata?.useWorktree,
			useLocalBranch: task.metadata?.useLocalBranch,
			tddMode: task.metadata?.tddMode,
			verifyLoop: task.metadata?.verifyLoop,
			captures: task.metadata?.captures,
			mobileTargets: task.metadata?.mobileTargets,
			enableStreaming: options?.enableStreaming ?? true,
			streamingSessionId: options?.streamingSessionId ?? taskId,
		};

		if (needsImplementation) {
			console.warn(
				"[TASK_START] Starting task execution (no subtasks) for:",
				task.specId,
			);
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);
		} else {
			console.warn(
				"[TASK_START] Starting task execution (has subtasks) for:",
				task.specId,
			);
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);
		}
	}

	/**
	 * Start a task: the board's Start button, and the main-process features
	 * that run a card themselves (`getTaskControl`).
	 */
	async function startTask(
		taskId: string,
		options?: TaskStartOptions,
	): Promise<boolean> {
		console.warn(
			"[TASK_START] Received request for taskId:",
			taskId,
			"with options:",
			options,
		);
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			console.warn("[TASK_START] No main window found");
			return false;
		}

		// A server card runs on the server; nothing starts on this computer.
		const serverCard = findServerCard(taskId);
		if (serverCard) {
			const started = await startServerCard(serverCard);
			if (!started.success) {
				mainWindow.webContents.send(
					IPC_CHANNELS.TASK_ERROR,
					taskId,
					started.error,
				);
			}
			return started.success;
		}

		// Validate prerequisites
		const validation = await validateTaskPrerequisites(taskId, mainWindow);
		if (!validation.success) {
			mainWindow.webContents.send(
				IPC_CHANNELS.TASK_ERROR,
				taskId,
				validation.error,
			);
			return false;
		}

		const { task, project } = validation;
		// A part of a split starts on the part it builds on, not the trunk.
		const stacked = await stackSplitPartBeforeStart(task, project);
		if (!stacked.ok) {
			mainWindow.webContents.send(
				IPC_CHANNELS.TASK_ERROR,
				taskId,
				splitStackError(task, stacked.error),
			);
			return false;
		}
		console.warn(
			"[TASK_START] Found task:",
			task.specId,
			"status:",
			task.status,
			"reviewReason:",
			task.reviewReason,
			"subtasks:",
			task.subtasks.length,
		);

		// Determine and execute start event
		const startEvent = determineStartEvent(taskId, task);
		const taskToUse = startEvent.resetTask || task;

		// A start event carries nothing but its type (determineStartEvent never
		// answers PR_CREATED, the one event with a payload).
		const event = { type: startEvent.type } as TaskEvent;

		taskStateManager.handleUiEvent(taskId, event, taskToUse, project);

		// Reset for new run
		taskStateManager.resetForNewRun(taskId);

		// Setup execution environment
		const { specDir, needsSpecCreation, needsImplementation } =
			setupTaskExecution(taskId, task, project);
		console.warn(
			"[TASK_START] hasSpec:",
			!needsSpecCreation,
			"needsSpecCreation:",
			needsSpecCreation,
			"needsImplementation:",
			needsImplementation,
		);

		// Who launched this run, beside the spec of the project's copy.
		recordTaskLauncher(
			path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId),
			project.path,
		);

		// The task runs on its own engine, never the default provider's.
		ensureTaskEngine(task, project, specDir);
		console.warn(
			"[TASK_START] Provider:",
			task.metadata?.provider ?? "none",
		);

		// Start execution
		startTaskExecution(
			taskId,
			task,
			project,
			specDir,
			needsSpecCreation,
			needsImplementation,
			options,
		);
		return true;
	}

	ipcMain.on(
		IPC_CHANNELS.TASK_START,
		(_, taskId: string, options?: TaskStartOptions) => {
			void startTask(taskId, options);
		},
	);

	/**
	 * Resume a Claude SDK session for a task that hit max_turns or max_budget_usd.
	 *
	 * Reads the session_id persisted by the Python backend in
	 * `<specDir>/.session.json` and re-spawns the build subprocess with
	 * AUTO_CLAUDE_RESUME_SESSION_ID set. The backend's create_client()
	 * picks it up and passes it to ClaudeAgentOptions(resume=...), so the
	 * SDK rehydrates the prior transcript instead of replaying from scratch.
	 *
	 * Distinct from TASK_RESUME_PAUSED which handles rate-limit/auth pauses.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_SESSION,
		async (_, taskId: string): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);
			const sessionFile = path.join(specDir, ".session.json");

			if (!existsSync(sessionFile)) {
				return {
					success: false,
					error:
						"No persisted SDK session found for this task — run it once first.",
				};
			}

			let sessionId: string | undefined;
			try {
				const raw = readFileSync(sessionFile, "utf-8");
				const parsed = JSON.parse(raw) as {
					session_id?: string;
					provider?: string | null;
				};
				// Codex records its thread id in the same file: handed to the
				// Claude SDK as a session to resume, it fails the run. A marker
				// with no provider predates the field and is Claude's.
				const provider = parsed.provider ?? "claude";
				if (provider !== "claude" && provider !== "anthropic") {
					return {
						success: false,
						error: `The saved session belongs to ${provider}: only a Claude session can be resumed.`,
					};
				}
				sessionId = parsed.session_id;
			} catch (err) {
				return {
					success: false,
					error: `Could not read .session.json: ${(err as Error).message}`,
				};
			}

			if (!sessionId) {
				return {
					success: false,
					error: ".session.json is missing the session_id field.",
				};
			}

			// Spawn the build subprocess with the resume flag carried in env.
			// Reuse startTaskExecution so the same auth/path checks fire.
			const executionOptions = {
				parallel: false,
				workers: 1,
				baseBranch: task.metadata?.baseBranch || project.settings?.mainBranch,
				useWorktree: task.metadata?.useWorktree,
				useLocalBranch: task.metadata?.useLocalBranch,
				enableStreaming: true,
				streamingSessionId: taskId,
				resumeSessionId: sessionId,
			};
			agentManager.startTaskExecution(
				taskId,
				project.path,
				task.specId,
				executionOptions,
				project.id,
			);

			appLog.info(
				`[TASK_RESUME_SESSION] Resumed task ${task.specId} with session_id=${sessionId}`,
			);
			return { success: true };
		},
	);

	/** Stop a task: the board's Stop button, and `getTaskControl`. */
	function stopTask(taskId: string): void {
		const serverCard = findServerCard(taskId);
		if (serverCard) {
			void stopServerCard(serverCard).then((stopped) => {
				if (!stopped.success) {
					getMainWindow()?.webContents.send(
						IPC_CHANNELS.TASK_ERROR,
						taskId,
						stopped.error,
					);
				}
			});
			return;
		}
		// haltTask (not killTask) also unregisters the task from the
		// OperationRegistry so a proactive profile-swap can't resurrect it after
		// the user stopped it.
		agentManager.haltTask(taskId);
		fileWatcher.unwatch(taskId);

		// Find task and project to emit USER_STOPPED with plan context
		const { task, project } = findTaskAndProject(taskId);

		if (!task || !project) return;

		// Clear any cooperative-pause flag so a stopped task isn't left looking
		// "paused" after it transitions out (e.g. to human_review).
		try {
			const specPaths = getSpecPaths(task, project);
			clearPauseState(
				allSpecDirs(specPaths),
				getPlanPaths(specPaths, project).all,
			);
		} catch (err) {
			appLog.warn(`[TASK_STOP] Could not clear pause flag for ${taskId}:`, err);
		}

		let hasPlan = false;
		try {
			const planPath = getPlanPath(project, task);
			const planContent = safeReadFileSync(planPath);
			if (planContent) {
				const plan = JSON.parse(planContent);
				const { totalCount } = checkSubtasksCompletion(plan);
				hasPlan = totalCount > 0;
			}
		} catch {
			hasPlan = false;
		}

		taskStateManager.handleUiEvent(
			taskId,
			{ type: "USER_STOPPED", hasPlan },
			task,
			project,
		);
	}

	ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => stopTask(taskId));

	taskControl = {
		start: startTask,
		stop: stopTask,
		isRunning: (taskId) => agentManager.isRunning(taskId),
	};

	const context: ExecutionHandlerContext = {
		agentManager,
		getMainWindow,
	};
	registerTaskReviewHandlers(context);
	registerTaskStatusHandlers(context);
	registerTaskResumeHandlers(context);
	registerTaskRecoveryHandlers(context);
	registerSubtaskUnblockHandlers(context);

	/**
	 * Check if a task is actually running (has active process)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CHECK_RUNNING,
		async (_, taskId: string): Promise<IPCResult<boolean>> => {
			const isRunning = agentManager.isRunning(taskId);
			return { success: true, data: isRunning };
		},
	);

	/**
	 * Update plan phases and subtasks
	 * Allows modifying pending subtasks or adding new ones
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_UPDATE_PLAN,
		async (
			_,
			taskId: string,
			phases: unknown,
		): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const edits = parsePlanEdit(phases);
			if (!edits) {
				return { success: false, error: "Invalid plan edit" };
			}

			const planPath = getPlanPath(project, task);
			const updatedPlan = await updatePlanSubtasks(
				planPath,
				edits,
				project.id,
			);

			if (!updatedPlan) {
				return {
					success: false,
					error: "Failed to update plan - file may not exist or be corrupted",
				};
			}

			appLog.info(
				`[TASK_UPDATE_PLAN] Successfully updated plan for task ${taskId}`,
			);
			return { success: true };
		},
	);

	registerPauseHandler(agentManager);

	/**
	 * Resume a paused task from where it stopped. See `resumePausedTask`, which
	 * is also what resumes, at launch, the tasks WorkPilot was running when it
	 * was closed.
	 */
	ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_, taskId: string): Promise<IPCResult> => {
		try {
			return await resumePausedTask(agentManager, taskId);
		} catch (error) {
			appLog.error("[TASK_RESUME] Error:", error);
			return { success: false, error: String(error) };
		}
	});

	// Provider switching mid-task is handled by TASK_RESUME_WITH_PROVIDER
	// (marker + conversation replay). The former TASK_SWITCH_PROVIDER handler
	// only wrote a flag with a hardcoded model list and never restarted the
	// run, so it was removed in favour of the single source of truth.
}
