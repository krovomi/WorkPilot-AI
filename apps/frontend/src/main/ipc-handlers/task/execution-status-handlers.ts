/**
 * Moving a task to another status by hand.
 * Split out of execution-handlers.ts (plan of 29 October, N8 A2).
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { pythonRunnerEnv } from "../../utils/python-runner-env";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import type { IPCResult, TaskStatus } from "../../../shared/types";
import { getAppLanguage } from "../../app-language";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { checkGitStatus } from "../../project-initializer";
import { projectStore } from "../../project-store";
import { pythonEnvManager } from "../../python-env-manager";
import { taskStateManager } from "../../task-state-manager";
import { findTaskWorktree } from "../../worktree-paths";
import { cleanupWorktree } from "../../utils/worktree-cleanup";
import {
	createPlanIfNotExists,
	getPlanPath,
	persistPlanStatus,
} from "./plan-file-utils";
import { findTaskAndProject } from "./shared";
import { convertTaskMetadataToSpecCreation } from "./resume-task";
import { extractPrCreationError } from "./pr-error-utils";
import { stripHtml } from "../shared/sanitize";
import {
	type ExecutionHandlerContext,
	ensureProfileManagerInitialized,
	ensureTaskEngine,
	recordReviewVerdictForLearning,
	requiresClaudeAuth,
} from "./execution-utils";

export function registerTaskStatusHandlers(ctx: ExecutionHandlerContext): void {
	const { agentManager, getMainWindow } = ctx;

	/**
	 * Update task status manually
	 * Options:
	 * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_UPDATE_STATUS,
		async (
			_,
			taskId: string,
			status: TaskStatus,
			options?: { forceCleanup?: boolean; skipPrCreation?: boolean },
		): Promise<
			IPCResult & { worktreeExists?: boolean; worktreePath?: string }
		> => {
			// Find task and project first (needed for worktree check)
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Validate status transition - 'done' creates a PR for human review
			// A worktree must exist with uncommitted or unpushed changes
			if (status === "done") {
				// If a PR already exists for this task, skip PR creation
				// (e.g. task moved out of "done" column and back in)
				const existingPrUrl = task.prUrl || task.metadata?.prUrl;
				if (existingPrUrl) {
					console.warn(
						`[TASK_UPDATE_STATUS] PR already exists for task ${taskId}: ${existingPrUrl} — skipping creation`,
					);
					status = "pr_created";
				}

				// Check if worktree exists (task.specId matches worktree folder name)
				const worktreePath = findTaskWorktree(project.path, task.specId);
				const hasWorktree = worktreePath !== null;

				if (!existingPrUrl && hasWorktree && !options?.skipPrCreation) {
					// Worktree exists - create PR for human validation
					console.warn(
						`[TASK_UPDATE_STATUS] Creating PR for task ${taskId} (status: done)`,
					);

					try {
						// Call Python service to create PR
						const pythonExecutable = pythonEnvManager.getPythonPath();
						if (!pythonExecutable) {
							appLog.error(`[TASK_UPDATE_STATUS] Python not configured`);
							return {
								success: false,
								error: "Python environment not configured",
							};
						}

						const backendPath = path.join(
							import.meta.dirname,
							"..",
							"..",
							"..",
							"backend",
						);

						// Prepare the script to call the task completion service.
						// Parameters are read from stdin (JSON), NOT argv: a task
						// description imported from Azure DevOps can embed a large
						// base64 inline image, and passing that on the command line
						// blows past the OS argument-length limit (~32 KB on Windows),
						// which made execFileSync fail before Python even started.
						const scriptContent = `
import json
import sys

from services.task_completion_service import create_task_completion_service

# Read parameters as JSON from stdin (see the note above).
# Decode the raw stdin bytes as UTF-8 explicitly: on Windows, sys.stdin's
# text wrapper defaults to the locale codepage (cp1252), which corrupts
# accented characters in spec ids / titles (e.g. "à" -> "\\ufffd\\xa0") and
# later trips the spec-name validation regex.
params = json.loads(sys.stdin.buffer.read().decode("utf-8"))

project_path = params["project_path"]
spec_id = params["spec_id"]
task_title = params["task_title"]
task_description = params.get("task_description") or None
base_branch = params.get("base_branch") or "develop"

# Create service and complete task
service = create_task_completion_service(project_path, base_branch)
result = service.complete_task(spec_id, task_title, task_description)

# Output result as JSON
print(json.dumps(result))
`;

						// Write temporary script
						const tmpScriptPath = path.join(
							project.path,
							".workpilot",
							"tmp_create_pr.py",
						);
						const tmpDir = path.dirname(tmpScriptPath);
						if (!existsSync(tmpDir)) {
							mkdirSync(tmpDir, { recursive: true });
						}
						writeFileSync(tmpScriptPath, scriptContent, "utf-8");

						// Get base branch from task metadata or project settings
						const baseBranch =
							task.metadata?.baseBranch ||
							project.settings?.mainBranch ||
							"develop";

						// Build the parameters payload. The description is stripped of
						// HTML so the PR body stays clean (no raw tags) and small
						// (no inline base64 image), keeping it well under GitHub's
						// PR-body size limit.
						const prParams = JSON.stringify({
							project_path: project.path,
							spec_id: task.specId,
							task_title: stripHtml(task.title) || task.title,
							task_description: stripHtml(task.description || ""),
							base_branch: baseBranch,
						});

						// Execute Python script to create PR.
						// Run from backendPath so Python resolves all internal imports
						// (core.*, debug, services.*) correctly. Parameters are passed
						// on stdin via `input` to avoid command-line length limits.
						// `input` is an explicit UTF-8 Buffer (not a string) so accented
						// characters survive the hand-off intact; PYTHONUTF8/IOENCODING
						// keep Python's own stdio on UTF-8 regardless of the OS locale.
						const result = execFileSync(pythonExecutable, [tmpScriptPath], {
							cwd: backendPath,
							encoding: "utf-8",
							timeout: 60000, // 60 seconds timeout for PR creation
							input: Buffer.from(prParams, "utf-8"),
							maxBuffer: 10 * 1024 * 1024, // PR output can be sizable
							env: await pythonRunnerEnv(backendPath, {
								extra: {
									APP_LANGUAGE: getAppLanguage(),
								},
							}),
						});

						// Clean up temporary script
						try {
							unlinkSync(tmpScriptPath);
						} catch {
							// Ignore cleanup errors
						}

						// Parse result
						const prResult = JSON.parse(result.trim());

						if (prResult.success) {
							console.warn(
								`[TASK_UPDATE_STATUS] PR created successfully: ${prResult.pr_url}`,
							);

							// Update task with PR URL
							const mainWindow = getMainWindow();
							if (mainWindow && prResult.pr_url) {
								mainWindow.webContents.send(
									IPC_CHANNELS.TASK_UPDATED_EVENT,
									taskId,
									{ prUrl: prResult.pr_url },
									project.id,
								);
							}

							// Clean up worktree after successful PR creation
							const worktreePath = findTaskWorktree(project.path, task.specId);
							if (worktreePath && existsSync(worktreePath)) {
								try {
									console.warn(
										`[TASK_UPDATE_STATUS] Cleaning up worktree after PR creation: ${worktreePath}`,
									);
									const cleanupResult = await cleanupWorktree({
										worktreePath,
										projectPath: project.path,
										specId: task.specId,
										commitMessage: "Auto-save before cleanup after PR creation",
										logPrefix: "[TASK_UPDATE_STATUS]",
										deleteBranch: true,
									});

									if (cleanupResult.success) {
										console.warn(
											`[TASK_UPDATE_STATUS] Worktree cleaned up after PR creation`,
										);
									} else {
										console.warn(
											`[TASK_UPDATE_STATUS] Worktree cleanup had warnings:`,
											cleanupResult.warnings,
										);
									}
								} catch (cleanupError) {
									console.error(
										`[TASK_UPDATE_STATUS] Error during worktree cleanup:`,
										cleanupError,
									);
									// Non-fatal - PR was created successfully
								}
							}

							// Transition to pr_created status
							status = "pr_created";
						} else {
							appLog.error(
								`[TASK_UPDATE_STATUS] Failed to create PR: ${prResult.error}`,
							);
							return {
								success: false,
								error: `Failed to create PR: ${prResult.error}`,
							};
						}
					} catch (prError) {
						appLog.error(`[TASK_UPDATE_STATUS] Error creating PR:`, prError);
						return {
							success: false,
							error: extractPrCreationError(prError),
						};
					}
				} else if (!existingPrUrl) {
					// Mark done without creating a PR. Either there is no worktree
					// (limbo-state recovery) or the user explicitly chose to close
					// without a PR (skipPrCreation) — e.g. the remote push is blocked
					// (Azure 403) or the change will be handled outside WorkPilot. The
					// worktree, if any, is left intact for reference.
					console.warn(
						`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} without PR creation (skipPrCreation=${Boolean(
							options?.skipPrCreation,
						)}, hasWorktree=${hasWorktree})`,
					);
				}
			}

			// Validate status transition - 'human_review' requires actual work to have been done
			// This prevents tasks from being incorrectly marked as ready for review when execution failed
			if (status === "human_review") {
				const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
				const specDirForValidation = path.join(
					project.path,
					specsBaseDirForValidation,
					task.specId,
				);
				const specFilePath = path.join(
					specDirForValidation,
					AUTO_BUILD_PATHS.SPEC_FILE,
				);

				// Check if spec.md exists and has meaningful content (at least 100 chars)
				const MIN_SPEC_CONTENT_LENGTH = 100;
				let specContent = "";
				try {
					if (existsSync(specFilePath)) {
						specContent = readFileSync(specFilePath, "utf-8");
					}
				} catch {
					// Ignore read errors - treat as empty spec
				}

				if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
					console.warn(
						`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`,
					);
					return {
						success: false,
						error:
							"Cannot move to human review - no spec has been created yet. The task must complete processing before review.",
					};
				}
			}

			// Get the spec directory and plan path using shared utility
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir = path.join(project.path, specsBaseDir, task.specId);
			const planPath = getPlanPath(project, task);

			// Validate status transition - 'ai_review' relaunches the QA validation,
			// which needs a spec and an implementation plan to validate against.
			// Validated BEFORE persisting: otherwise the task would be stored as
			// ai_review with no process and immediately flagged as stuck.
			if (status === "ai_review" && !agentManager.isRunning(taskId)) {
				const specFileForQa = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
				if (!existsSync(specFileForQa) || task.subtasks.length === 0) {
					console.warn(
						`[TASK_UPDATE_STATUS] Blocked attempt to set status 'ai_review' for task ${taskId}. No spec or implementation plan to validate.`,
					);
					return {
						success: false,
						error:
							"Cannot start AI review - the task has no spec or implementation plan yet. The task must be implemented before QA validation.",
					};
				}
			}

			try {
				const handledByMachine = taskStateManager.handleManualStatusChange(
					taskId,
					status,
					task,
					project,
				);
				if (!handledByMachine) {
					// Use shared utility for thread-safe plan file updates (legacy/manual override)
					const persisted = await persistPlanStatus(
						planPath,
						status,
						project.id,
					);

					if (!persisted) {
						// If no implementation plan exists yet, create a basic one
						await createPlanIfNotExists(planPath, task, status);
						// Invalidate cache after creating new plan
						projectStore.invalidateTasksCache(project.id);
					}
				}

				// Feed the learning loop with the human verdict on a reviewed task.
				// `task.status` is still the pre-change status here.
				recordReviewVerdictForLearning(task.status, status, project, task);

				// Auto-stop task when status changes AWAY from 'in_progress' and process IS running
				// This handles the case where user drags a running task back to Planning/backlog
				if (status !== "in_progress" && agentManager.isRunning(taskId)) {
					console.warn(
						"[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:",
						taskId,
					);
					agentManager.killTask(taskId);
				}

				// Auto-start QA validation when status changes to 'ai_review' and no
				// process is running. Without this, moving a task to "AI Review" only
				// persists the status while the renderer's stuck-detection expects a
				// live process — the task would show as "needs recovery" after 60s.
				// (killTask above removes process tracking synchronously, so a task
				// dragged straight from in_progress lands here with isRunning false.)
				if (status === "ai_review" && !agentManager.isRunning(taskId)) {
					const mainWindow = getMainWindow();

					// Check git status before auto-starting
					const gitStatusCheckForQa = checkGitStatus(project.path);
					if (
						!gitStatusCheckForQa.isGitRepo ||
						!gitStatusCheckForQa.hasCommits
					) {
						console.warn(
							"[TASK_UPDATE_STATUS] Git check failed, cannot start QA validation",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								gitStatusCheckForQa.error ||
									"Git repository with commits required to run tasks.",
							);
						}
						return {
							success: false,
							error: gitStatusCheckForQa.error || "Git repository required",
						};
					}

					// Check authentication before auto-starting
					const initResultForQa = await ensureProfileManagerInitialized();
					if (!initResultForQa.success) {
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								initResultForQa.error,
							);
						}
						return { success: false, error: initResultForQa.error };
					}
					if (
						requiresClaudeAuth(task, project) &&
						!initResultForQa.profileManager.hasValidAuth()
					) {
						console.warn(
							"[TASK_UPDATE_STATUS] No valid authentication for active profile",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								"Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.",
							);
						}
						return { success: false, error: "Claude authentication required" };
					}

					console.warn(
						"[TASK_UPDATE_STATUS] Starting QA validation for:",
						task.specId,
					);

					// Start file watcher for this task
					fileWatcher.watch(taskId, specDir);

					// The task runs on its own engine, never the default provider's.
					ensureTaskEngine(task, project, specDir);

					await agentManager.startQAProcess(
						taskId,
						project.path,
						task.specId,
						project.id,
					);

					// Notify renderer about status change
					if (mainWindow) {
						mainWindow.webContents.send(
							IPC_CHANNELS.TASK_STATUS_CHANGE,
							taskId,
							"ai_review",
							project.id,
						);
					}
				}

				// Auto-start task when status changes to 'in_progress' and no process is running
				if (status === "in_progress" && !agentManager.isRunning(taskId)) {
					const mainWindow = getMainWindow();

					// Check git status before auto-starting
					const gitStatusCheck = checkGitStatus(project.path);
					if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
						console.warn(
							"[TASK_UPDATE_STATUS] Git check failed, cannot auto-start task",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								gitStatusCheck.error ||
									"Git repository with commits required to run tasks.",
							);
						}
						return {
							success: false,
							error: gitStatusCheck.error || "Git repository required",
						};
					}

					// Check authentication before auto-starting
					// Ensure profile manager is initialized to prevent race condition
					const initResult = await ensureProfileManagerInitialized();
					if (!initResult.success) {
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								initResult.error,
							);
						}
						return { success: false, error: initResult.error };
					}
					const profileManager = initResult.profileManager;
					if (requiresClaudeAuth(task, project) && !profileManager.hasValidAuth()) {
						console.warn(
							"[TASK_UPDATE_STATUS] No valid authentication for active profile",
						);
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_ERROR,
								taskId,
								"Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.",
							);
						}
						return { success: false, error: "Claude authentication required" };
					}

					console.warn("[TASK_UPDATE_STATUS] Auto-starting task:", taskId);

					// Start file watcher for this task
					fileWatcher.watch(taskId, specDir);

					// Check if spec.md exists
					const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
					const hasSpec = existsSync(specFilePath);
					const needsSpecCreation = !hasSpec;
					const needsImplementation = hasSpec && task.subtasks.length === 0;

					console.warn(
						"[TASK_UPDATE_STATUS] hasSpec:",
						hasSpec,
						"needsSpecCreation:",
						needsSpecCreation,
						"needsImplementation:",
						needsImplementation,
					);

					// The task runs on its own engine, never the default provider's.
					ensureTaskEngine(task, project, specDir);

					// Get base branch: task-level override takes precedence over project settings
					const baseBranchForUpdate =
						task.metadata?.baseBranch || project.settings?.mainBranch;

					if (needsSpecCreation) {
						// No spec file - need to run spec_runner.py to create the spec
						const taskDescription = task.description || task.title;
						console.warn(
							"[TASK_UPDATE_STATUS] Starting spec creation for:",
							task.specId,
						);
						agentManager.startSpecCreation(
							taskId,
							project.path,
							taskDescription,
							specDir,
							convertTaskMetadataToSpecCreation(task.metadata),
							baseBranchForUpdate,
							project.id,
						);
					} else if (needsImplementation) {
						// Spec exists but no subtasks - run run.py to create implementation plan and execute
						console.warn(
							"[TASK_UPDATE_STATUS] Starting task execution (no subtasks) for:",
							task.specId,
						);
						agentManager.startTaskExecution(
							taskId,
							project.path,
							task.specId,
							{
								parallel: false,
								workers: 1,
								baseBranch: baseBranchForUpdate,
								useWorktree: task.metadata?.useWorktree,
								useLocalBranch: task.metadata?.useLocalBranch,
							},
							project.id,
						);
					} else {
						// Task has subtasks, start normal execution
						// Note: Parallel execution is handled internally by the agent
						console.warn(
							"[TASK_UPDATE_STATUS] Starting task execution (has subtasks) for:",
							task.specId,
						);
						agentManager.startTaskExecution(
							taskId,
							project.path,
							task.specId,
							{
								parallel: false,
								workers: 1,
								baseBranch: baseBranchForUpdate,
								useWorktree: task.metadata?.useWorktree,
								useLocalBranch: task.metadata?.useLocalBranch,
							},
							project.id,
						);
					}

					// Notify renderer about status change
					if (mainWindow) {
						mainWindow.webContents.send(
							IPC_CHANNELS.TASK_STATUS_CHANGE,
							taskId,
							"in_progress",
							project.id,
						);
					}
				}

				return { success: true };
			} catch (error) {
				appLog.error("Failed to update task status:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to update task status",
				};
			}
		},
	);
}
