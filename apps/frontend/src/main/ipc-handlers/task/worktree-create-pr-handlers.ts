/**
 * Opening a pull request from a task's worktree.
 * Split out of worktree-handlers.ts (plan of 29 October, N8 A2).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	WorktreeCreatePROptions,
	WorktreeCreatePRResult,
	VisualProofRun,
} from "../../../shared/types";
import { stripAnsiCodes } from "../../../shared/utils/ansi-sanitizer";
import { getAppLanguage } from "../../app-language";
import { getToolPath } from "../../cli-tool-manager";
import { killProcessGracefully } from "../../platform";
import { parsePythonCommand } from "../../python-detector";
import { findServerCard } from "../../server-board-actions";
import { createServerCardPR } from "../../server-board-review";
import {
	getConfiguredPythonPath,
	type PythonEnvManager,
	pythonEnvManager as pythonEnvManagerSingleton,
} from "../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../rate-limit-detector";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { visualProofService } from "../../visual-proof-service";
import { findTaskWorktree } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";
import { getTaskBaseBranch } from "./worktree-git-refs";
import {
	loadProjectEnvForSubprocess,
	parsePRJsonOutput,
	updateTaskStatusAfterPRCreation,
	updateVisualProofMetadata,
	buildCreatePRArgs,
	initializePythonEnvForPR,
} from "./worktree-pr-helpers";
import { PR_CREATION_TIMEOUT_MS } from "./worktree-handler-utils";

export function registerWorktreeCreatePRHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	/**
	 * Create a Pull Request from the worktree branch
	 * Pushes the branch to origin and creates a GitHub PR using gh CLI
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_CREATE_PR,
		async (
			_,
			taskId: string,
			options?: WorktreeCreatePROptions,
		): Promise<IPCResult<WorktreeCreatePRResult>> => {
			const serverCard = findServerCard(taskId);
			if (serverCard) return createServerCardPR(serverCard, options);
			const isDebugMode =
				process.env.DEBUG === "true" || process.env.NODE_ENV === "development";
			const debug = (...args: unknown[]) => {
				if (isDebugMode) {
					console.warn("[CREATE_PR DEBUG]", ...args);
				}
			};

			try {
				debug("Handler called with taskId:", taskId, "options:", options);

				// Ensure Python environment is ready
				const pythonEnvError = await initializePythonEnvForPR(pythonEnvManager);
				if (pythonEnvError) {
					return { success: false, error: pythonEnvError };
				}

				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					debug("Task or project not found");
					return { success: false, error: "Task not found" };
				}

				debug("Found task:", task.specId, "project:", project.path);

				// Use run.py --create-pr to handle the PR creation
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

				// Use EAFP pattern - try to read specDir and catch ENOENT
				try {
					statSync(specDir);
				} catch (err) {
					if (
						err &&
						typeof err === "object" &&
						"code" in err &&
						err.code === "ENOENT"
					) {
						debug("Spec directory not found:", specDir);
						return { success: false, error: "Spec directory not found" };
					}
					throw err; // Re-throw unexpected errors
				}

				// Check worktree exists before creating PR
				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (!worktreePath) {
					debug("No worktree found for spec:", task.specId);
					return { success: false, error: "No worktree found for this task" };
				}
				debug("Worktree path:", worktreePath);

				// If a customBody was provided (review modal), write it to a
				// temporary file so we can pass --pr-body-file to the Python
				// CLI without dealing with command-line escaping / size limits.
				let customBodyTempDir: string | null = null;
				let customBodyFilePath: string | undefined;
				if (options?.customBody !== undefined) {
					try {
						customBodyTempDir = mkdtempSync(
							path.join(tmpdir(), "workpilot-pr-body-"),
						);
						customBodyFilePath = path.join(customBodyTempDir, "body.md");
						writeFileSync(customBodyFilePath, options.customBody, "utf-8");
					} catch (writeErr) {
						debug("Failed to write custom body temp file:", writeErr);
						return {
							success: false,
							error: "Failed to write custom PR body to temporary file",
						};
					}
				}

				// Cleanup helper - safe to call multiple times
				const cleanupCustomBodyFile = () => {
					if (customBodyTempDir) {
						try {
							rmSync(customBodyTempDir, { recursive: true, force: true });
						} catch (cleanupErr) {
							debug("Failed to clean up custom body temp dir:", cleanupErr);
						}
						customBodyTempDir = null;
					}
				};

				// Build arguments using helper function
				const taskBaseBranch = getTaskBaseBranch(specDir);
				const { args, validationError } = buildCreatePRArgs(
					runScript,
					task.specId,
					project.path,
					options,
					taskBaseBranch,
					customBodyFilePath,
				);
				if (validationError) {
					cleanupCustomBodyFile();
					return { success: false, error: validationError };
				}
				if (taskBaseBranch) {
					debug("Using stored base branch:", taskBaseBranch);
				}

				// Use configured Python path
				const pythonPath = getConfiguredPythonPath();
				debug("Running command:", pythonPath, args.join(" "));
				debug("Working directory:", sourcePath);

				// Get profile environment with OAuth token
				const profileResult = getBestAvailableProfileEnv();
				const profileEnv = profileResult.env;

				// Forward project-level credentials (.workpilot/.env) into the
				// Python subprocess so PR creation can authenticate against
				// Azure DevOps / GitHub / GitLab. Without this the Python
				// _get_azure_devops_credentials() sees an empty PAT and the
				// API call returns HTTP 401 ("authentication failed").
				const projectEnv = loadProjectEnvForSubprocess(project);

				return new Promise<IPCResult<WorktreeCreatePRResult>>((resolve) => {
					let timeoutId: NodeJS.Timeout | null = null;
					let resolved = false;

					// Get Python environment for bundled packages
					const pythonEnv = pythonEnvManagerSingleton.getPythonEnv();

					// Get gh CLI path to pass to Python backend
					const ghCliPath = getToolPath("gh");

					// Parse Python command to handle space-separated commands like "py -3"
					const [pythonCommand, pythonBaseArgs] =
						parsePythonCommand(pythonPath);
					const createPRProcess = spawn(
						pythonCommand,
						[...pythonBaseArgs, ...args],
						{
							cwd: sourcePath,
							env: {
								...getIsolatedGitEnv(),
								...pythonEnv,
								...profileEnv,
								...projectEnv,
								GITHUB_CLI_PATH: ghCliPath,
								APP_LANGUAGE: getAppLanguage(),
								PYTHONUNBUFFERED: "1",
								PYTHONUTF8: "1",
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
								"TIMEOUT: Create PR process exceeded",
								PR_CREATION_TIMEOUT_MS,
								"ms, killing...",
							);
							resolved = true;

							// Platform-specific process termination with fallback
							killProcessGracefully(createPRProcess, {
								debugPrefix: "[PR_CREATION]",
								debug: isDebugMode,
							});

							resolve({
								success: false,
								error:
									"PR creation timed out. Check if the PR was created on GitHub.",
							});
						}
					}, PR_CREATION_TIMEOUT_MS);

					createPRProcess.stdout.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						stdout += chunk;
						debug("STDOUT:", chunk);
					});

					createPRProcess.stderr.on("data", (data: Buffer) => {
						const chunk = data.toString("utf-8");
						stderr += chunk;
						debug("STDERR:", chunk);
					});

					/**
					 * Handle process exit - shared logic for both 'close' and 'exit' events.
					 * Parses JSON output, updates task status if PR was created, and resolves the promise.
					 *
					 * @param code - Process exit code (0 = success, non-zero = failure)
					 * @param eventSource - Which event triggered this ('close' or 'exit') for debug logging
					 */
					const handleCreatePRProcessExit = async (
						code: number | null,
						eventSource: "close" | "exit",
					): Promise<void> => {
						if (resolved) return;
						resolved = true;
						if (timeoutId) clearTimeout(timeoutId);

						debug(`Process exited via ${eventSource} event with code:`, code);
						debug("Full stdout:", stdout);
						debug("Full stderr:", stderr);

						if (code === 0) {
							// Parse JSON output using helper function
							const result = parsePRJsonOutput(stdout);
							if (result) {
								debug("Parsed result:", result);

								// Persist the PR URL onto the task in ALL cases where we
								// have one — including when the PR already existed (the
								// user is pushing a new commit onto an existing PR). This
								// guarantees the Kanban item always carries the PR link.
								let visualProof: VisualProofRun | undefined;
								if (result.success !== false && result.prUrl) {
									await updateTaskStatusAfterPRCreation(
										specDir,
										worktreePath,
										result.prUrl,
										project.autoBuildPath,
										task.specId,
										debug,
									);
									if (result.alreadyExists) {
										debug(
											"PR already exists, refreshed task status with existing PR URL",
										);
									}
									if (options?.runVisualProof !== false) {
										visualProof = await visualProofService.run({
											taskId: task.id,
											projectPath: project.path,
											specId: task.specId,
											prUrl: result.prUrl,
											worktreePath,
											autoBuildPath: project.autoBuildPath,
										});
										updateVisualProofMetadata(
											specDir,
											worktreePath,
											project.autoBuildPath,
											task.specId,
											visualProof,
											debug,
										);

										const mainWindow = getMainWindow();
										if (mainWindow) {
											mainWindow.webContents.send(
												IPC_CHANNELS.TASK_UPDATED_EVENT,
												task.id,
												{ metadata: { visualProof } },
												project.id,
											);
										}
									}
								}

								resolve({
									success: true,
									data: {
										success: result.success,
										prUrl: result.prUrl,
										error: result.error,
										alreadyExists: result.alreadyExists,
										visualProof,
									},
								});
							} else {
								// No JSON found, but process succeeded
								debug("No JSON in output, assuming success");
								resolve({
									success: true,
									data: {
										success: true,
										prUrl: undefined,
									},
								});
							}
						} else {
							debug("Process failed with code:", code);

							// Try to parse JSON from stdout even on failure
							const result = parsePRJsonOutput(stdout);
							if (result) {
								debug("Parsed error result:", result);
								resolve({
									success: false,
									error: result.error || "Failed to create PR",
									// The dialog offers "create anyway" only on this.
									...(result.crossReviewBlocked && {
										data: {
											success: false,
											error: result.error,
											crossReviewBlocked: true,
										},
									}),
								});
							} else {
								// Fallback to raw output if JSON parsing fails
								// Prefer stdout over stderr since stderr often contains debug messages
								resolve({
									success: false,
									error: stripAnsiCodes(
										stdout || stderr || "Failed to create PR",
									),
								});
							}
						}
					};

					createPRProcess.on("close", (code: number | null) => {
						handleCreatePRProcessExit(code, "close");
					});

					// Also listen to 'exit' event in case 'close' doesn't fire
					createPRProcess.on("exit", (code: number | null) => {
						// Give close event a chance to fire first with complete output
						setTimeout(() => handleCreatePRProcessExit(code, "exit"), 100);
					});

					createPRProcess.on("error", (err: Error) => {
						if (resolved) return;
						resolved = true;
						if (timeoutId) clearTimeout(timeoutId);
						debug("Process spawn error:", err);
						resolve({
							success: false,
							error: `Failed to run create-pr: ${err.message}`,
						});
					});
				}).finally(cleanupCustomBodyFile);
			} catch (error) {
				console.error("[CREATE_PR] Exception in handler:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Failed to create PR",
				};
			}
		},
	);
}
