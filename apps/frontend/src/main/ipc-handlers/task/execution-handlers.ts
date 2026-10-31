
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
import { projectStore } from "../../project-store";
import { taskStateManager } from "../../task-state-manager";
import { getPlanPath, updatePlanSubtasks } from "./plan-file-utils";
import {
	clearPauseState,
	type PauseStateRecord,
	writePauseState,
} from "./pause-state-utils";
import { findTaskAndProject } from "./shared";
import {
	allSpecDirs,
	convertTaskMetadataToSpecCreation,
	currentPausePhase,
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
	 * Start a task
	 */
	ipcMain.on(
		IPC_CHANNELS.TASK_START,
		async (_, taskId: string, options?: TaskStartOptions) => {
			console.warn(
				"[TASK_START] Received request for taskId:",
				taskId,
				"with options:",
				options,
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				console.warn("[TASK_START] No main window found");
				return;
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
				return;
			}

			// Validate prerequisites
			const validation = await validateTaskPrerequisites(taskId, mainWindow);
			if (!validation.success) {
				mainWindow.webContents.send(
					IPC_CHANNELS.TASK_ERROR,
					taskId,
					validation.error,
				);
				return;
			}

			const { task, project } = validation;
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

			// Create proper event object based on type
			let event: TaskEvent;
			if (startEvent.type === "PR_CREATED") {
				// This case shouldn't happen in start event, but handle for type safety
				event = { type: startEvent.type, prUrl: "" };
			} else {
				event = { type: startEvent.type } as TaskEvent;
			}

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
				const parsed = JSON.parse(raw) as { session_id?: string };
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

	/**
	 * Stop a task
	 */
	ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
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
	});

	const context: ExecutionHandlerContext = {
		agentManager,
		getMainWindow,
	};
	registerTaskReviewHandlers(context);
	registerTaskStatusHandlers(context);
	registerTaskResumeHandlers(context);
	registerTaskRecoveryHandlers(context);

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
			phases: Array<Record<string, unknown>>,
		): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const planPath = getPlanPath(project, task);
			const updatedPlan = await updatePlanSubtasks(
				planPath,
				phases,
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

	/**
	 * Pause task execution, at whatever phase it is in.
	 *
	 * The flag goes to `pause_state.json`, not into `implementation_plan.json`:
	 * that file does not exist during spec creation or planning, so the previous
	 * version answered "Implementation plan not found" for a task the user could
	 * see running. The backend reads the same file from its coder loop, its QA
	 * loop and its spec pipeline, so one Pause click stops all three.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_PAUSE,
		async (_, taskId: string, subtaskId?: string): Promise<IPCResult> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const specPaths = getSpecPaths(task, project);
				const specDirs = allSpecDirs(specPaths);
				if (specDirs.length === 0) {
					return { success: false, error: "Spec directory not found" };
				}

				const phase = currentPausePhase(task, specPaths);
				const pausedState: PauseStateRecord = {
					enabled: true,
					paused_at: new Date().toISOString(),
					paused_phase: phase,
					paused_subtask_id:
						subtaskId ?? task.executionProgress?.currentSubtask ?? null,
					provider: task.metadata?.provider ?? null,
					model: task.metadata?.model ?? null,
				};

				const written = writePauseState(specDirs, pausedState);

				if (written === 0) {
					return { success: false, error: "Could not write pause state" };
				}

				// Re-scan so the scanner surfaces the pause on task.metadata; the
				// UI uses that to switch the controls into the paused state.
				projectStore.invalidateTasksCache(project.id);

				// Immediate pause: stop the running subprocess NOW rather than
				// waiting for the backend to reach its next cooperative checkpoint
				// (which, mid-session, can be a long way off). haltTask marks the
				// spawn as killed (its exit handler returns early WITHOUT emitting
				// "exit" — no PROCESS_EXITED/USER_STOPPED, so the card keeps its
				// current column) AND unregisters the task from the
				// OperationRegistry so the proactive profile-swap / usage monitor
				// cannot resurrect the paused process when a token limit is hit.
				// The flag written above drives the UI and a clean resume.
				const wasRunning = agentManager.haltTask(taskId);

				appLog.info(
					`[TASK_PAUSE] Task ${taskId} paused during ${phase} at subtask ` +
						`${pausedState.paused_subtask_id ?? "none"} (${written} spec ` +
						`dir(s)); subprocess ${wasRunning ? "killed" : "was not running"}.`,
				);

				return {
					success: true,
					data: {
						taskId,
						paused: true,
						pausedAt: pausedState.paused_at,
						pausedPhase: phase,
						specDirs: written,
					},
				};
			} catch (error) {
				appLog.error("[TASK_PAUSE] Error:", error);
				return { success: false, error: String(error) };
			}
		},
	);

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
