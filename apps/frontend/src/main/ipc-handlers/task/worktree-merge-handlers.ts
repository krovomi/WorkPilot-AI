/**
 * Merging a task's worktree into its base branch, and the preview before it.
 * Split out of worktree-handlers.ts (plan of 29 October, N8 A2).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import { AUTO_BUILD_PATHS, IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	TaskStatus,
	WorktreeMergeResult,
} from "../../../shared/types";
import { stripAnsiCodes } from "../../../shared/utils/ansi-sanitizer";
import { getToolPath } from "../../cli-tool-manager";
import { killProcessGracefully } from "../../platform";
import { parsePythonCommand } from "../../python-detector";
import {
	getConfiguredPythonPath,
	type PythonEnvManager,
	pythonEnvManager as pythonEnvManagerSingleton,
} from "../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../rate-limit-detector";
import { taskStateManager } from "../../task-state-manager";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { getIsolatedGitEnv, refreshGitIndex } from "../../utils/git-isolation";
import { findTaskWorktree } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";
import { getTaskBaseBranch } from "./worktree-git-refs";
import { withRetry } from "./worktree-pr-helpers";
import {
	extractLastJsonObject,
	fixMisconfiguredBareRepo,
	getUtilitySettings,
	isGitWorkTree,
} from "./worktree-handler-utils";

export function registerWorktreeMergeHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Merge the worktree changes into the main branch
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_MERGE,
		async (
			_,
			taskId: string,
			options?: { noCommit?: boolean },
		): Promise<IPCResult<WorktreeMergeResult>> => {
			const isDebugMode =
				process.env.DEBUG === "true" || process.env.NODE_ENV === "development";
			const debug = (...args: unknown[]) => {
				if (isDebugMode) {
					console.warn("[MERGE DEBUG]", ...args);
				}
			};

			try {
				debug("Handler called with taskId:", taskId, "options:", options);

				// Ensure Python environment is ready
				if (!pythonEnvManager.isEnvReady()) {
					const autoBuildSource = getEffectiveSourcePath();
					if (autoBuildSource) {
						const status = await pythonEnvManager.initialize(autoBuildSource);
						if (!status.ready) {
							return {
								success: false,
								error: `Python environment not ready: ${status.error || "Unknown error"}`,
							};
						}
					} else {
						return {
							success: false,
							error:
								"Python environment not ready and WorkPilot AI source not found",
						};
					}
				}

				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					debug("Task or project not found");
					return { success: false, error: "Task not found" };
				}

				debug("Found task:", task.specId, "project:", project.path);

				// Auto-fix any misconfigured bare repo before merge operation
				// This prevents issues where git operations fail due to incorrect bare=true config
				if (fixMisconfiguredBareRepo(project.path)) {
					debug("Fixed misconfigured bare repository at:", project.path);
				}

				// Use run.py --merge to handle the merge
				const sourcePath = getEffectiveSourcePath();
				if (!sourcePath) {
					return { success: false, error: "WorkPilot AI source not found" };
				}

				const runScript = path.join(sourcePath, "run.py");
				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);

				if (!existsSync(specDir)) {
					debug("Spec directory not found:", specDir);
					return { success: false, error: "Spec directory not found" };
				}

				// Check worktree exists before merge
				const worktreePath = findTaskWorktree(project.path, task.specId);
				debug("Worktree path:", worktreePath, "exists:", !!worktreePath);

				// Check if changes are already staged (for stage-only mode)
				if (options?.noCommit) {
					const stagedResult = spawnSync(
						getToolPath("git"),
						["diff", "--staged", "--name-only"],
						{
							cwd: project.path,
							encoding: "utf-8",
							env: getIsolatedGitEnv(),
						},
					);

					if (stagedResult.status === 0 && stagedResult.stdout?.trim()) {
						const stagedFiles = stagedResult.stdout.trim().split("\n");
						debug("Changes already staged:", stagedFiles.length, "files");
						// Return success - changes are already staged
						return {
							success: true,
							data: {
								success: true,
								merged: false,
								message: `Changes already staged (${stagedFiles.length} files). Review with git diff --staged.`,
								staged: true,
								alreadyStaged: true,
								projectPath: project.path,
							},
						};
					}
				}

				// Get git status before merge (only if project is a working tree, not a bare repo)
				if (isGitWorkTree(project.path)) {
					try {
						const gitStatusBefore = execFileSync(
							getToolPath("git"),
							["status", "--short"],
							{ cwd: project.path, encoding: "utf-8" },
						);
						debug(
							"Git status BEFORE merge in main project:\n",
							gitStatusBefore || "(clean)",
						);
						const gitBranch = execFileSync(
							getToolPath("git"),
							["branch", "--show-current"],
							{ cwd: project.path, encoding: "utf-8" },
						).trim();
						debug("Current branch:", gitBranch);
					} catch (e) {
						debug("Failed to get git status before:", e);
					}
				} else {
					debug(
						"Project is a bare repository - skipping pre-merge git status check",
					);
				}

				const args = [
					runScript,
					"--spec",
					task.specId,
					"--project-dir",
					project.path,
					"--merge",
				];

				// Add --no-commit flag if requested (stage changes without committing)
				if (options?.noCommit) {
					args.push("--no-commit");
				}

				// Add --base-branch with proper priority:
				// 1. Task metadata baseBranch (explicit task-level override)
				// 2. Project settings mainBranch (project-level default)
				// This matches the logic in execution-handlers.ts
				const taskBaseBranch = getTaskBaseBranch(specDir);
				const projectMainBranch = project.settings?.mainBranch;
				const effectiveBaseBranch = taskBaseBranch || projectMainBranch;

				if (effectiveBaseBranch) {
					args.push("--base-branch", effectiveBaseBranch);
					debug(
						"Using base branch:",
						effectiveBaseBranch,
						`(source: ${taskBaseBranch ? "task metadata" : "project settings"})`,
					);
				}

				// Use configured Python path (venv if ready, otherwise bundled/system)
				const pythonPath = getConfiguredPythonPath();
				debug("Running command:", pythonPath, args.join(" "));
				debug("Working directory:", sourcePath);

				// Get profile environment with OAuth token for AI merge resolution
				const profileResult = getBestAvailableProfileEnv();
				const profileEnv = profileResult.env;
				debug("Profile env for merge:", {
					hasOAuthToken: !!profileEnv.CLAUDE_CODE_OAUTH_TOKEN,
					hasConfigDir: !!profileEnv.CLAUDE_CONFIG_DIR,
				});

				return new Promise((resolve) => {
					const MERGE_TIMEOUT_MS = 600000; // 10 minutes timeout for AI merge operations with many files
					let timeoutId: NodeJS.Timeout | null = null;
					let resolved = false;

					// Get Python environment for bundled packages
					const pythonEnv = pythonEnvManagerSingleton.getPythonEnv();

					// Get utility settings for merge resolver
					const utilitySettings = getUtilitySettings();
					debug("Utility settings for merge:", utilitySettings);

					// Parse Python command to handle space-separated commands like "py -3"
					const [pythonCommand, pythonBaseArgs] =
						parsePythonCommand(pythonPath);
					const mergeProcess = spawn(
						pythonCommand,
						[...pythonBaseArgs, ...args],
						{
							cwd: sourcePath,
							env: {
								...getIsolatedGitEnv(),
								...pythonEnv,
								...profileEnv,
								PYTHONUNBUFFERED: "1",
								PYTHONUTF8: "1",
								UTILITY_MODEL: utilitySettings.model,
								UTILITY_MODEL_ID: utilitySettings.modelId,
								UTILITY_THINKING_BUDGET:
									utilitySettings.thinkingBudget === null
										? ""
										: utilitySettings.thinkingBudget?.toString() || "",
							},
							stdio: ["ignore", "pipe", "pipe"],
						},
					);

					let stdout = "";
					let stderr = "";

					// Set up timeout to kill hung processes
					timeoutId = setTimeout(() => {
						if (!resolved) {
							debug(
								"TIMEOUT: Merge process exceeded",
								MERGE_TIMEOUT_MS,
								"ms, killing...",
							);
							resolved = true;

							// Send timeout error progress event to the renderer
							const mainWindow = getMainWindow();
							if (mainWindow) {
								mainWindow.webContents.send(
									IPC_CHANNELS.TASK_MERGE_PROGRESS,
									taskId,
									{
										type: "progress",
										stage: "error",
										percent: 0,
										message: "Merge process timed out after 10 minutes",
										details: {},
									},
								);
							}

							// Platform-specific process termination with fallback
							killProcessGracefully(mergeProcess, {
								debugPrefix: "[MERGE]",
								debug: isDebugMode,
							});

							// Check if merge might have succeeded before the hang
							// Look for success indicators in the output
							const mayHaveSucceeded =
								stdout.includes("staged") ||
								stdout.includes("Successfully merged") ||
								stdout.includes("Changes from");

							if (mayHaveSucceeded) {
								debug(
									"TIMEOUT: Process hung but merge may have succeeded based on output",
								);
								const isStageOnly = options?.noCommit === true;
								resolve({
									success: true,
									data: {
										success: true,
										message:
											"Changes staged (process timed out but merge appeared successful)",
										staged: isStageOnly,
										projectPath: isStageOnly ? project.path : undefined,
									},
								});
							} else {
								resolve({
									success: false,
									error:
										"Merge process timed out. Check git status to see if merge completed.",
								});
							}
						}
					}, MERGE_TIMEOUT_MS);

					let lineBuffer = ""; // Buffer for partial JSON lines spanning data chunks

					mergeProcess.stdout.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						debug("STDOUT:", chunk);

						// Prepend any buffered partial line from previous chunk
						const combined = lineBuffer + chunk;
						const lines = combined.split("\n");

						// Last element may be a partial line - buffer it for next chunk
						lineBuffer = lines.pop() || "";

						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed) continue;

							try {
								const parsed = JSON.parse(trimmed);
								// Validate parsed object has expected MergeProgress structure before forwarding
								if (
									parsed &&
									parsed.type === "progress" &&
									typeof parsed.stage === "string" &&
									typeof parsed.percent === "number" &&
									typeof parsed.message === "string"
								) {
									const mainWindow = getMainWindow();
									if (mainWindow) {
										mainWindow.webContents.send(
											IPC_CHANNELS.TASK_MERGE_PROGRESS,
											taskId,
											parsed,
										);
									}
									// Don't accumulate progress lines in stdout - they are not part of the final result
									continue;
								}
							} catch {
								// Not valid JSON - treat as regular output
							}

							// Accumulate non-progress lines for final result parsing
							stdout += `${line}\n`;
						}
					});

					mergeProcess.stderr.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						stderr += chunk;
						debug("STDERR:", chunk);
					});

					// Handler for when process exits
					const handleProcessExit = async (
						code: number | null,
						signal: string | null = null,
					) => {
						if (resolved) return; // Prevent double-resolution
						resolved = true;
						if (timeoutId) clearTimeout(timeoutId);

						// Flush any remaining buffered line
						if (lineBuffer.trim()) {
							try {
								const parsed = JSON.parse(lineBuffer.trim());
								if (parsed && parsed.type === "progress") {
									const mainWindow = getMainWindow();
									if (mainWindow) {
										mainWindow.webContents.send(
											IPC_CHANNELS.TASK_MERGE_PROGRESS,
											taskId,
											parsed,
										);
									}
								} else {
									stdout += lineBuffer;
								}
							} catch {
								stdout += lineBuffer;
							}
							lineBuffer = "";
						}

						debug("Process exited with code:", code, "signal:", signal);
						debug("Full stdout:", stdout);
						debug("Full stderr:", stderr);

						// Get git status after merge (only if project is a working tree, not a bare repo)
						if (isGitWorkTree(project.path)) {
							try {
								const gitStatusAfter = execFileSync(
									getToolPath("git"),
									["status", "--short"],
									{ cwd: project.path, encoding: "utf-8" },
								);
								debug(
									"Git status AFTER merge in main project:\n",
									gitStatusAfter || "(clean)",
								);
								const gitDiffStaged = execFileSync(
									getToolPath("git"),
									["diff", "--staged", "--stat"],
									{ cwd: project.path, encoding: "utf-8" },
								);
								debug("Staged changes:\n", gitDiffStaged || "(none)");
							} catch (e) {
								debug("Failed to get git status after:", e);
							}
						} else {
							debug(
								"Project is a bare repository - skipping git status check (this is normal for worktree-based projects)",
							);
						}

						if (code === 0) {
							const isStageOnly = options?.noCommit === true;

							// Verify changes were actually staged when stage-only mode is requested
							// This prevents false positives when merge was already committed previously
							let hasActualStagedChanges = false;
							let mergeAlreadyCommitted = false;

							if (isStageOnly) {
								// Only check staged changes if project is a working tree (not bare repo)
								if (isGitWorkTree(project.path)) {
									try {
										const gitDiffStaged = execFileSync(
											getToolPath("git"),
											["diff", "--staged", "--stat"],
											{ cwd: project.path, encoding: "utf-8" },
										);
										hasActualStagedChanges = gitDiffStaged.trim().length > 0;
										debug(
											"Stage-only verification: hasActualStagedChanges:",
											hasActualStagedChanges,
										);

										if (!hasActualStagedChanges) {
											// Check if worktree branch was already merged (merge commit exists)
											const specBranch = `workpilot/${task.specId}`;
											try {
												// Check if current branch contains all commits from spec branch
												// git merge-base --is-ancestor returns exit code 0 if true, 1 if false
												execFileSync(
													getToolPath("git"),
													["merge-base", "--is-ancestor", specBranch, "HEAD"],
													{
														cwd: project.path,
														encoding: "utf-8",
														stdio: ["pipe", "pipe", "pipe"],
													},
												);
												// If we reach here, the command succeeded (exit code 0) - branch is merged
												mergeAlreadyCommitted = true;
												debug(
													"Merge already committed check:",
													mergeAlreadyCommitted,
												);
											} catch {
												// Exit code 1 means not merged, or branch may not exist
												mergeAlreadyCommitted = false;
												debug(
													"Could not check merge status, assuming not merged",
												);
											}
										}
									} catch (e) {
										debug("Failed to verify staged changes:", e);
									}
								} else {
									// For bare repos, skip staging verification - merge happens in worktree
									debug(
										"Project is a bare repository - skipping staged changes verification",
									);
								}
							}

							// Determine actual status based on verification
							let newStatus: string;
							let planStatus: string;
							let message: string;
							let staged: boolean;

							if (
								isStageOnly &&
								!hasActualStagedChanges &&
								mergeAlreadyCommitted
							) {
								// Stage-only was requested but merge was already committed previously
								// Keep in human_review and let user explicitly mark as done (which will trigger cleanup confirmation)
								// This ensures user is in control of when the worktree is deleted
								newStatus = "human_review";
								planStatus = "review";
								message =
									"Changes were already merged and committed. You can mark this task as complete when ready.";
								staged = false;
								debug(
									"Stage-only requested but merge already committed. Keeping in human_review for user to confirm completion.",
								);
								// NOTE: We intentionally do NOT auto-clean the worktree here.
								// User can drag the task to "Done" column which will show a confirmation dialog
								// asking if they want to delete the worktree and mark complete.
							} else if (isStageOnly && !hasActualStagedChanges) {
								// Stage-only was requested but no changes to stage (and not committed)
								// This could mean nothing to merge or an error - keep in human_review for investigation
								newStatus = "human_review";
								planStatus = "review";
								message =
									"No changes to stage. The worktree may have no differences from the current branch.";
								staged = false;
								debug("Stage-only requested but no changes to stage.");
							} else if (isStageOnly) {
								// Stage-only with actual staged changes - expected success case
								newStatus = "human_review";
								planStatus = "review";
								message =
									"Changes staged in main project. Review with git status and commit when ready.";
								staged = true;
							} else {
								// Full merge (not stage-only)
								// Keep in human_review to allow user validation before completion
								newStatus = "human_review";
								planStatus = "review";
								message = "Changes merged successfully. Review and mark complete when ready.";
								staged = false;

								// NOTE: Do NOT auto-cleanup worktree after merge
								// User must explicitly drag task to "Done" column to confirm cleanup
								// This prevents accidental data loss and ensures user validates merge first.
								// The worktree will be cleaned up when user moves task to "Done" status.
							}

							debug(
								"Merge result. isStageOnly:",
								isStageOnly,
								"newStatus:",
								newStatus,
								"staged:",
								staged,
							);
							const reviewReason =
								newStatus === "human_review" ? "completed" : undefined;

							// Read suggested commit message if staging succeeded
							// OPTIMIZATION: Use async I/O to prevent blocking
							let suggestedCommitMessage: string | undefined;
							if (staged) {
								const commitMsgPath = path.join(
									specDir,
									"suggested_commit_message.txt",
								);
								try {
									if (existsSync(commitMsgPath)) {
										const { promises: fsPromises } = require("node:fs");
										suggestedCommitMessage = (
											await fsPromises.readFile(commitMsgPath, "utf-8")
										).trim();
										debug(
											"Read suggested commit message:",
											suggestedCommitMessage?.substring(0, 100),
										);
									}
								} catch (e) {
									debug("Failed to read suggested commit message:", e);
								}
							}

							// Persist the status change to implementation_plan.json
							// Issue #243: We must update BOTH the main project's plan AND the worktree's plan (if it exists)
							// because ProjectStore prefers the worktree version when deduplicating tasks.
							// OPTIMIZATION: Use async I/O and parallel updates to prevent UI blocking
							// NOTE: The worktree has the same directory structure as main project
							const planPaths: { path: string; isMain: boolean }[] = [
								{
									path: path.join(
										specDir,
										AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
									),
									isMain: true,
								},
							];
							// Add worktree plan path if worktree exists
							if (worktreePath) {
								const worktreeSpecDir = path.join(
									worktreePath,
									project.autoBuildPath || ".workpilot",
									"specs",
									task.specId,
								);
								planPaths.push({
									path: path.join(
										worktreeSpecDir,
										AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
									),
									isMain: false,
								});
							}

							const { promises: fsPromises } = require("node:fs");

							// Update plan file with retry logic for transient failures
							// Uses EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
							const updatePlanWithRetry = async (
								planPath: string,
								isMain: boolean,
							): Promise<boolean> => {
								// Helper to check if error is ENOENT (file not found)
								const isFileNotFound = (err: unknown): boolean =>
									!!(
										err &&
										typeof err === "object" &&
										"code" in err &&
										err.code === "ENOENT"
									);

								try {
									await withRetry(
										async () => {
											const planContent = await fsPromises.readFile(
												planPath,
												"utf-8",
											);
											const plan = JSON.parse(planContent);
											plan.status = newStatus;
											plan.planStatus = planStatus;
											plan.reviewReason = reviewReason;
											plan.updated_at = new Date().toISOString();
											if (staged) {
												plan.stagedAt = new Date().toISOString();
												plan.stagedInMainProject = true;
											}
											await fsPromises.writeFile(
												planPath,
												JSON.stringify(plan, null, 2),
												"utf-8",
											);

											// Verify the write succeeded by reading back
											const verifyContent = await fsPromises.readFile(
												planPath,
												"utf-8",
											);
											const verifyPlan = JSON.parse(verifyContent);
											if (
												verifyPlan.status !== newStatus ||
												verifyPlan.planStatus !== planStatus
											) {
												throw new Error(
													"Write verification failed - status mismatch",
												);
											}
										},
										{
											maxRetries: 3,
											baseDelayMs: 100,
											shouldRetry: (err) => !isFileNotFound(err), // Don't retry if file doesn't exist
										},
									);
									return true;
								} catch (err) {
									// File doesn't exist - nothing to update (not an error)
									if (isFileNotFound(err)) {
										return true;
									}
									// Only log error if main plan fails; worktree plan might legitimately be missing or read-only
									if (isMain) {
										console.error(
											"Failed to persist task status to main plan after retries:",
											err,
										);
									} else {
										debug(
											"Failed to persist task status to worktree plan (non-critical):",
											err,
										);
									}
									return false;
								}
							};

							const updatePlans = async () => {
								const results = await Promise.all(
									planPaths.map(({ path: planPath, isMain }) =>
										updatePlanWithRetry(planPath, isMain),
									),
								);
								// Log if main plan update failed (first element)
								if (!results[0]) {
									console.warn(
										"Background plan update: main plan write may not have persisted",
									);
								}
							};

							// IMPORTANT: Wait for plan updates to complete before responding (fixes #243)
							// Previously this was "fire and forget" which caused a race condition:
							// resolve() would return before files were written, and UI refresh would read old status
							try {
								await updatePlans();
							} catch (err) {
								debug("Plan update failed:", err);
								// Non-fatal: UI will still update, but status may not persist across refresh
							}

							// Route status change through TaskStateManager (XState) to avoid dual emission
							taskStateManager.handleManualStatusChange(
								taskId,
								newStatus as TaskStatus,
								task,
								project,
							);

							resolve({
								success: true,
								data: {
									success: true,
									message,
									staged,
									projectPath: staged ? project.path : undefined,
									suggestedCommitMessage,
								},
							});
						} else {
							// Check if there were actual merge conflicts
							// More specific patterns to avoid false positives from debug output like "files_with_conflicts: 0"
							const conflictPatterns = [
								/CONFLICT \(/i, // Git merge conflict marker
								/merge conflict/i, // Explicit merge conflict message
								/\bconflict detected\b/i, // Our own conflict detection message
								/\bconflicts? found\b/i, // "conflicts found" or "conflict found"
								/Automatic merge failed/i, // Git's automatic merge failure message
							];
							const combinedOutput = stdout + stderr;
							const hasConflicts = conflictPatterns.some((pattern) =>
								pattern.test(combinedOutput),
							);
							debug("Merge failed. hasConflicts:", hasConflicts);

							resolve({
								success: true,
								data: {
									success: false,
									message: hasConflicts
										? "Merge conflicts detected"
										: `Merge failed: ${stripAnsiCodes(stderr || stdout)}`,
									conflictFiles: hasConflicts ? [] : undefined,
								},
							});
						}
					};

					mergeProcess.on(
						"close",
						(code: number | null, signal: string | null) => {
							handleProcessExit(code, signal);
						},
					);

					// Also listen to 'exit' event in case 'close' doesn't fire
					mergeProcess.on(
						"exit",
						(code: number | null, signal: string | null) => {
							// Give close event a chance to fire first with complete output
							setTimeout(() => handleProcessExit(code, signal), 100);
						},
					);

					mergeProcess.on("error", (err: Error) => {
						if (resolved) return;
						resolved = true;
						if (timeoutId) clearTimeout(timeoutId);
						console.error("[MERGE] Process spawn error:", err);

						// Send error progress event to the renderer
						const mainWindow = getMainWindow();
						if (mainWindow) {
							mainWindow.webContents.send(
								IPC_CHANNELS.TASK_MERGE_PROGRESS,
								taskId,
								{
									type: "progress",
									stage: "error",
									percent: 0,
									message: `Merge process crashed: ${err.message}`,
									details: {},
								},
							);
						}

						resolve({
							success: false,
							error: `Failed to run merge: ${err.message}`,
						});
					});
				});
			} catch (error) {
				console.error("[MERGE] Exception in merge handler:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to merge worktree",
				};
			}
		},
	);

	/**
	 * Preview merge conflicts before actually merging
	 * Uses the smart merge system to analyze potential conflicts
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW,
		async (_, taskId: string): Promise<IPCResult<WorktreeMergeResult>> => {
			console.warn(
				"[IPC] TASK_WORKTREE_MERGE_PREVIEW called with taskId:",
				taskId,
			);
			try {
				// Ensure Python environment is ready
				if (!pythonEnvManager.isEnvReady()) {
					console.warn("[IPC] Python environment not ready, initializing...");
					const autoBuildSource = getEffectiveSourcePath();
					if (autoBuildSource) {
						const status = await pythonEnvManager.initialize(autoBuildSource);
						if (!status.ready) {
							console.error(
								"[IPC] Python environment failed to initialize:",
								status.error,
							);
							return {
								success: false,
								error: `Python environment not ready: ${status.error || "Unknown error"}`,
							};
						}
					} else {
						console.error("[IPC] WorkPilot AI source not found");
						return {
							success: false,
							error:
								"Python environment not ready and WorkPilot AI source not found",
						};
					}
				}

				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					console.error("[IPC] Task not found:", taskId);
					return { success: false, error: "Task not found" };
				}
				console.warn(
					"[IPC] Found task:",
					task.specId,
					"project:",
					project.name,
				);

				// Check for uncommitted changes in the main project (only if not a bare repo)
				let hasUncommittedChanges = false;
				let uncommittedFiles: string[] = [];
				if (isGitWorkTree(project.path)) {
					try {
						refreshGitIndex(project.path);

						const gitStatus = execFileSync(
							getToolPath("git"),
							["status", "--porcelain"],
							{
								cwd: project.path,
								encoding: "utf-8",
							},
						);

						if (gitStatus?.trim()) {
							// Parse the status output to get file names
							// Format: XY filename (where X and Y are status chars, then space, then filename)
							uncommittedFiles = gitStatus
								.split("\n")
								.filter((line) => line.trim())
								.map((line) => line.substring(3).trim()) // Skip 2 status chars + 1 space, trim any trailing whitespace
								.filter((file) => file); // Remove empty strings from short/malformed status lines

							hasUncommittedChanges = uncommittedFiles.length > 0;
						}
					} catch (e) {
						console.error("[IPC] Failed to check git status:", e);
					}
				} else {
					console.warn(
						"[IPC] Project is a bare repository - skipping uncommitted changes check",
					);
				}

				const sourcePath = getEffectiveSourcePath();
				if (!sourcePath) {
					console.error("[IPC] WorkPilot AI source not found");
					return { success: false, error: "WorkPilot AI source not found" };
				}

				const runScript = path.join(sourcePath, "run.py");
				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);
				const args = [
					runScript,
					"--spec",
					task.specId,
					"--project-dir",
					project.path,
					"--merge-preview",
				];

				// Add --base-branch with proper priority:
				// 1. Task metadata baseBranch (explicit task-level override)
				// 2. Project settings mainBranch (project-level default)
				// This matches the logic in execution-handlers.ts
				const taskBaseBranch = getTaskBaseBranch(specDir);
				const projectMainBranch = project.settings?.mainBranch;
				const effectiveBaseBranch = taskBaseBranch || projectMainBranch;

				if (effectiveBaseBranch) {
					args.push("--base-branch", effectiveBaseBranch);
					console.warn(
						"[IPC] Using base branch for preview:",
						effectiveBaseBranch,
						`(source: ${taskBaseBranch ? "task metadata" : "project settings"})`,
					);
				}

				// Use configured Python path (venv if ready, otherwise bundled/system)
				const pythonPath = getConfiguredPythonPath();
				console.warn(
					"[IPC] Running merge preview:",
					pythonPath,
					args.join(" "),
				);

				// Get profile environment for consistency
				const previewProfileResult = getBestAvailableProfileEnv();
				const previewProfileEnv = previewProfileResult.env;
				// Get Python environment for bundled packages
				const previewPythonEnv = pythonEnvManagerSingleton.getPythonEnv();

				return new Promise((resolve) => {
					// Parse Python command to handle space-separated commands like "py -3"
					const [pythonCommand, pythonBaseArgs] =
						parsePythonCommand(pythonPath);
					const previewProcess = spawn(
						pythonCommand,
						[...pythonBaseArgs, ...args],
						{
							cwd: sourcePath,
							env: {
								...getIsolatedGitEnv(),
								...previewPythonEnv,
								...previewProfileEnv,
								PYTHONUNBUFFERED: "1",
								PYTHONUTF8: "1",
								DEBUG: "true",
							},
						},
					);

					let stdout = "";
					let stderr = "";

					previewProcess.stdout.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						stdout += chunk;
						console.warn("[IPC] merge-preview stdout:", chunk);
					});

					previewProcess.stderr.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						stderr += chunk;
						console.warn("[IPC] merge-preview stderr:", chunk);
					});

					previewProcess.on("close", (code: number) => {
						console.warn("[IPC] merge-preview process exited with code:", code);
						if (code === 0) {
							try {
								// The Python backend interleaves DEBUG log lines with the
								// final `print(json.dumps(result))` on the same stdout
								// stream. JSON.parse on the whole blob fails. Walk the
								// lines bottom-up and pick the last one that parses as
								// a JSON object — that's the result line.
								const parsed = extractLastJsonObject(stdout);
								if (!parsed) {
									throw new Error(
										"No JSON object found in backend stdout",
									);
								}
								// The shape comes straight from the Python CLI; we
								// re-cast it to the consumer shape below. Treating it
								// as `any` here keeps the existing typing of the IPC
								// response unchanged.
								// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON from Python CLI
								const result = parsed as any;
								console.warn(
									"[IPC] merge-preview result:",
									JSON.stringify(result, null, 2),
								);
								resolve({
									success: true,
									data: {
										success: result.success,
										message: result.error || "Preview completed",
										preview: {
											files: result.files || [],
											conflicts: result.conflicts || [],
											summary: result.summary || {
												totalFiles: 0,
												conflictFiles: 0,
												totalConflicts: 0,
												autoMergeable: 0,
												hasGitConflicts: false,
											},
											gitConflicts: result.gitConflicts || null,
											// Include uncommitted changes info for the frontend
											uncommittedChanges: hasUncommittedChanges
												? {
														hasChanges: true,
														files: uncommittedFiles,
														count: uncommittedFiles.length,
													}
												: null,
										},
									},
								});
							} catch (parseError) {
								console.error(
									"[IPC] Failed to parse preview result:",
									parseError,
								);
								console.error("[IPC] stdout:", stdout);
								console.error("[IPC] stderr:", stderr);
								resolve({
									success: false,
									error: `Failed to parse preview result: ${stripAnsiCodes(stderr || stdout)}`,
								});
							}
						} else {
							console.error("[IPC] Preview failed with exit code:", code);
							console.error("[IPC] stderr:", stderr);
							console.error("[IPC] stdout:", stdout);
							resolve({
								success: false,
								error: `Preview failed: ${stripAnsiCodes(stderr || stdout)}`,
							});
						}
					});

					previewProcess.on("error", (err: Error) => {
						console.error("[IPC] merge-preview spawn error:", err);
						resolve({
							success: false,
							error: `Failed to run preview: ${err.message}`,
						});
					});
				});
			} catch (error) {
				console.error("[IPC] TASK_WORKTREE_MERGE_PREVIEW error:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to preview merge",
				};
			}
		},
	);
}
