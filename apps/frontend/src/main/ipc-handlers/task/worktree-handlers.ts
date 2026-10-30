import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type BrowserWindow, ipcMain } from "electron";
import {
	AUTO_BUILD_PATHS,
	getSpecsDir,
	IPC_CHANNELS,
} from "../../../shared/constants";
import type {
	IPCResult,
	SupportedIDE,
	SupportedTerminal,
	WorktreeDiscardResult,
	WorktreeListItem,
	WorktreeListResult,
	WorktreeStatus,
} from "../../../shared/types";
import { stripAnsiCodes } from "../../../shared/utils/ansi-sanitizer";
import { getAppLanguage } from "../../app-language";
import { getToolPath } from "../../cli-tool-manager";
import { killProcessGracefully } from "../../platform";
import { projectStore } from "../../project-store";
import { readSettingsFile } from "../../settings-utils";
import { parsePythonCommand } from "../../python-detector";
import {
	getConfiguredPythonPath,
	type PythonEnvManager,
	pythonEnvManager as pythonEnvManagerSingleton,
} from "../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../rate-limit-detector";
import { taskStateManager } from "../../task-state-manager";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import { cleanupWorktree } from "../../utils/worktree-cleanup";
import { findTaskWorktree, getTaskWorktreeDir } from "../../worktree-paths";
import { findTaskAndProject } from "./shared";
import {
	detectInstalledTools,
	openInIDE,
	openInTerminal,
	resolveOpenableDir,
} from "./worktree-ide-terminal";
import type { DetectedTools } from "./worktree-ide-terminal";
import {
	GIT_BRANCH_REGEX,
	getEffectiveBaseBranch,
	resolveDiffRefs,
} from "./worktree-git-refs";
import {
	loadProjectEnvForSubprocess,
	initializePythonEnvForPR,
} from "./worktree-pr-helpers";
import { registerWorktreeDiffHandlers } from "./worktree-diff-handlers";
import { registerWorktreeMergeHandlers } from "./worktree-merge-handlers";
import { registerWorktreeFileHandlers } from "./worktree-file-handlers";
import { registerWorktreeCreatePRHandlers } from "./worktree-create-pr-handlers";
import { registerWorktreeVisualProofHandlers } from "./worktree-visual-proof-handlers";
// Moved to ./worktree-git-refs.ts (audit lot L11, F36); re-exported for existing importers.
export { GIT_BRANCH_REGEX, validateWorktreeBranch } from "./worktree-git-refs";

/**
 * Register worktree management handlers
 */
export function registerWorktreeHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	registerWorktreeDiffHandlers();
	registerWorktreeMergeHandlers(pythonEnvManager, getMainWindow);
	registerWorktreeFileHandlers();
	registerWorktreeCreatePRHandlers(pythonEnvManager, getMainWindow);
	registerWorktreeVisualProofHandlers(pythonEnvManager, getMainWindow);

	/**
	 * Get the worktree status for a task
	 * Per-spec architecture: Each spec has its own worktree at .workpilot/worktrees/tasks/{spec-name}/
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_STATUS,
		async (_, taskId: string): Promise<IPCResult<WorktreeStatus>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Find worktree at .workpilot/worktrees/tasks/{spec-name}/
				const worktreePath = findTaskWorktree(project.path, task.specId);

				if (!worktreePath) {
					return {
						success: true,
						data: { exists: false },
					};
				}

				// Get branch info from git
				try {
					// Get current branch in worktree
					const branch = execFileSync(
						getToolPath("git"),
						["rev-parse", "--abbrev-ref", "HEAD"],
						{
							cwd: worktreePath,
							encoding: "utf-8",
						},
					).trim();

					// Get base branch using proper fallback chain:
					// 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
					const baseBranch = getEffectiveBaseBranch(
						project.path,
						task.specId,
						project.settings?.mainBranch,
					);

					// Préférer les refs distantes (origin/...) quand elles existent
					// pour que le compteur reflète l'état publié dans la PR plutôt
					// qu'un HEAD local potentiellement divergent.
					const diffRefs = resolveDiffRefs(
						worktreePath,
						branch,
						baseBranch,
					);

					// Get user's current branch in main project (this is where changes will merge INTO)
					let currentProjectBranch: string | undefined;
					try {
						currentProjectBranch = execFileSync(
							getToolPath("git"),
							["rev-parse", "--abbrev-ref", "HEAD"],
							{
								cwd: project.path,
								encoding: "utf-8",
							},
						).trim();
					} catch {
						// Ignore - might be in detached HEAD or git error
					}

					// Get commit count (cross-platform - no shell syntax)
					let commitCount = 0;
					try {
						const countOutput = execFileSync(
							getToolPath("git"),
							[
								"rev-list",
								"--count",
								`${diffRefs.baseRef}..${diffRefs.headRef}`,
							],
							{
								cwd: worktreePath,
								encoding: "utf-8",
								stdio: ["pipe", "pipe", "pipe"],
							},
						).trim();
						commitCount = parseInt(countOutput, 10) || 0;
					} catch {
						commitCount = 0;
					}

					// Get diff stats — utilise --numstat pour pouvoir exclure
					// les fichiers que l'utilisateur a annulés via
					// .workpilot-discard-list (cohérent avec TASK_WORKTREE_DIFF).
					let filesChanged = 0;
					let additions = 0;
					let deletions = 0;

					try {
						const numstat = execFileSync(
							getToolPath("git"),
							[
								"diff",
								"--numstat",
								`${diffRefs.baseRef}...${diffRefs.headRef}`,
							],
							{
								cwd: worktreePath,
								encoding: "utf-8",
								stdio: ["pipe", "pipe", "pipe"],
							},
						).trim();

						// Charge la discard list (optionnelle) pour exclure
						// les fichiers que l'utilisateur ne veut pas voir.
						const discardListPath = path.join(
							worktreePath,
							".workpilot-discard-list",
						);
						let discardedFiles: string[] = [];
						try {
							const content = readFileSync(discardListPath, "utf-8");
							discardedFiles = content
								.split("\n")
								.map((line) => line.trim())
								.filter((line) => line && !line.startsWith("#"));
						} catch (err) {
							const isMissing =
								err instanceof Error &&
								(err as NodeJS.ErrnoException).code === "ENOENT";
							if (!isMissing) {
								console.error(
									"[TASK_WORKTREE_STATUS] Error reading discard list:",
									err,
								);
							}
						}

						const discardSet = new Set(discardedFiles);
						numstat
							.split("\n")
							.filter(Boolean)
							.forEach((line: string) => {
								const [adds, dels, filePath] = line.split("\t");
								if (!filePath || discardSet.has(filePath)) {
									return;
								}
								filesChanged += 1;
								additions += parseInt(adds, 10) || 0;
								deletions += parseInt(dels, 10) || 0;
							});
					} catch {
						// Ignore diff errors
					}

					return {
						success: true,
						data: {
							exists: true,
							worktreePath,
							branch,
							baseBranch,
							currentProjectBranch,
							commitCount,
							filesChanged,
							additions,
							deletions,
						},
					};
				} catch (gitError) {
					console.error("Git error getting worktree status:", gitError);
					return {
						success: true,
						data: { exists: true, worktreePath },
					};
				}
			} catch (error) {
				console.error("Failed to get worktree status:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to get worktree status",
				};
			}
		},
	);



	/**
	 * Discard the worktree changes
	 * Per-spec architecture: Each spec has its own worktree at .workpilot/worktrees/tasks/{spec-name}/
	 *
	 * Note: Uses the shared cleanupWorktree utility which handles Windows-specific issues
	 * where `git worktree remove --force` fails when the directory contains untracked files.
	 * See: https://github.com/AndyMik90/Auto-Claude/issues/1539
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DISCARD,
		async (
			_,
			taskId: string,
			skipStatusChange?: boolean,
		): Promise<IPCResult<WorktreeDiscardResult>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Find worktree at .workpilot/worktrees/tasks/{spec-name}/
				const worktreePath = findTaskWorktree(project.path, task.specId);

				if (!worktreePath) {
					return {
						success: true,
						data: {
							success: true,
							message: "No worktree to discard",
						},
					};
				}

				// Use the shared cleanup utility for robust, cross-platform worktree deletion
				const cleanupResult = await cleanupWorktree({
					worktreePath,
					projectPath: project.path,
					specId: task.specId,
					commitMessage: "Auto-save before discard",
					logPrefix: "[TASK_WORKTREE_DISCARD]",
					deleteBranch: true,
				});

				if (!cleanupResult.success) {
					console.error(
						"[TASK_WORKTREE_DISCARD] Cleanup failed:",
						cleanupResult.warnings,
					);
					return {
						success: false,
						error: `Failed to discard worktree: ${cleanupResult.warnings.join("; ")}`,
					};
				}

				// Log any non-fatal warnings
				if (cleanupResult.warnings.length > 0) {
					console.warn(
						"[TASK_WORKTREE_DISCARD] Cleanup warnings:",
						cleanupResult.warnings,
					);
				}
				if (cleanupResult.autoCommitted) {
					console.warn(
						"[TASK_WORKTREE_DISCARD] Auto-committed uncommitted work before discard",
					);
				}

				// Only send status change to backlog if not skipped
				// (skip when caller will set a different status, e.g., 'done')
				if (!skipStatusChange) {
					// Route through TaskStateManager (XState) to avoid dual emission
					taskStateManager.handleManualStatusChange(
						taskId,
						"backlog",
						task,
						project,
					);
				}

				return {
					success: true,
					data: {
						success: true,
						message: "Worktree discarded successfully",
					},
				};
			} catch (error) {
				console.error("Failed to discard worktree:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to discard worktree",
				};
			}
		},
	);

	// Promisified execFile for async git operations
	const execFileAsync = promisify(execFile);

	/**
	 * Discard an orphaned worktree by spec name (no task association required)
	 * Used when the worktree exists but the task is missing or git state is corrupted
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN,
		async (
			_,
			projectId: string,
			specName: string,
		): Promise<IPCResult<WorktreeDiscardResult>> => {
			try {
				// Validate inputs
				if (!projectId || typeof projectId !== "string") {
					console.error(
						"discardOrphanedWorktree: Invalid projectId:",
						projectId,
					);
					return { success: false, error: "Invalid projectId" };
				}
				if (!specName || typeof specName !== "string") {
					console.error("discardOrphanedWorktree: Invalid specName:", specName);
					return { success: false, error: "Invalid specName" };
				}

				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				// Validate project.path
				if (!project.path || typeof project.path !== "string") {
					console.error(
						"discardOrphanedWorktree: Project path is invalid:",
						project.path,
					);
					return { success: false, error: "Project path is invalid" };
				}

				// Find worktree at .workpilot/worktrees/tasks/{spec-name}/
				const worktreePath = findTaskWorktree(project.path, specName);

				if (!worktreePath) {
					return {
						success: true,
						data: {
							success: true,
							message: "No worktree to discard",
						},
					};
				}

				// Use cleanupWorktree which auto-commits any uncommitted changes before deletion
				// This preserves work in git history (recoverable via reflog for ~90 days)
				const cleanupResult = await cleanupWorktree({
					worktreePath,
					projectPath: project.path,
					specId: specName,
					commitMessage: "Auto-save before orphaned worktree deletion",
					logPrefix: "[ORPHAN_CLEANUP]",
					deleteBranch: true,
				});

				if (!cleanupResult.success) {
					return {
						success: false,
						error:
							cleanupResult.warnings.join(", ") ||
							"Failed to cleanup orphaned worktree",
					};
				}

				return {
					success: true,
					data: {
						success: true,
						message: cleanupResult.autoCommitted
							? "Orphaned worktree deleted (uncommitted changes were auto-saved)"
							: "Orphaned worktree deleted successfully",
					},
				};
			} catch (error) {
				console.error("Failed to discard orphaned worktree:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to discard orphaned worktree",
				};
			}
		},
	);

	/**
	 * List all spec worktrees for a project
	 * Per-spec architecture: Each spec has its own worktree at .workpilot/worktrees/tasks/{spec-name}/
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_LIST_WORKTREES,
		async (_, projectId: string): Promise<IPCResult<WorktreeListResult>> => {
			try {
				// Validate projectId
				if (!projectId || typeof projectId !== "string") {
					console.error("listWorktrees: Invalid projectId:", projectId);
					return { success: false, error: "Invalid projectId" };
				}

				const project = projectStore.getProject(projectId);
				if (!project) {
					return { success: false, error: "Project not found" };
				}

				// Validate project.path
				if (!project.path || typeof project.path !== "string") {
					console.error(
						"listWorktrees: Project path is invalid:",
						project.path,
					);
					return { success: false, error: "Project path is invalid" };
				}

				const worktreesDir = getTaskWorktreeDir(project.path);

				// Fetch tasks once before iterating (avoids repeated lookups per entry)
				// Used for orphan detection - worktrees without a matching task are orphaned
				const tasks = projectStore.getTasks(projectId);
				// Track if task lookup was successful (empty array with existing specs dir = lookup failed)
				const mainSpecsDir = path.join(project.path, ".workpilot", "specs");
				const taskLookupSuccessful =
					tasks.length > 0 || !existsSync(mainSpecsDir);

				// Helper to process a single worktree entry (async)
				const processWorktreeEntry = async (
					entry: string,
					entryPath: string,
				): Promise<WorktreeListItem | null> => {
					try {
						// Get branch info (async)
						const branchResult = await execFileAsync(
							getToolPath("git"),
							["rev-parse", "--abbrev-ref", "HEAD"],
							{
								cwd: entryPath,
								encoding: "utf-8",
							},
						);
						const branch = (branchResult.stdout as string).trim();

						// Get base branch using proper fallback chain:
						// 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
						// Note: We do NOT use current HEAD as that may be a feature branch
						const baseBranch = getEffectiveBaseBranch(
							project.path,
							entry,
							project.settings?.mainBranch,
						);

						// Get commit count (async, cross-platform - no shell syntax)
						let commitCount = 0;
						try {
							const countResult = await execFileAsync(
								getToolPath("git"),
								["rev-list", "--count", `${baseBranch}..HEAD`],
								{
									cwd: entryPath,
									encoding: "utf-8",
								},
							);
							commitCount =
								parseInt((countResult.stdout as string).trim(), 10) || 0;
						} catch {
							commitCount = 0;
						}

						// Get diff stats (async, cross-platform - no shell syntax)
						let filesChanged = 0;
						let additions = 0;
						let deletions = 0;

						try {
							const diffResult = await execFileAsync(
								getToolPath("git"),
								["diff", "--numstat", `${baseBranch}...HEAD`],
								{
									cwd: entryPath,
									encoding: "utf-8",
								},
							);
							for (const line of (diffResult.stdout as string).split(/\r?\n/)) {
								const [added, deleted, filePath] = line.split("\t", 3);
								if (!filePath) continue;
								filesChanged += 1;
								// Git reports binary files with "-" instead of line counts.
								if (/^\d+$/.test(added)) additions += Number(added);
								if (/^\d+$/.test(deleted)) deletions += Number(deleted);
							}
						} catch {
							// Ignore diff errors
						}

						// Check if there's a task associated with this worktree
						// A worktree without a task is considered orphaned (can happen if task was deleted)
						// Only mark as orphaned if task lookup was successful (avoid false positives)
						const hasTask = tasks.some((t) => t.specId === entry);

						return {
							specName: entry,
							path: entryPath,
							branch,
							baseBranch,
							commitCount,
							filesChanged,
							additions,
							deletions,
							isOrphaned: taskLookupSuccessful ? !hasTask : false,
						};
					} catch (gitError) {
						// FIX: Don't skip worktree if git fails - it may be orphaned/corrupted
						// Include it so it can be managed (deleted if orphaned)
						const hasTask = tasks.some((t) => t.specId === entry);
						console.warn(
							`[Worktree] Git commands failed for ${entry}, hasTask=${hasTask}:`,
							gitError,
						);
						// Note: branch is empty - renderer should handle based on isOrphaned flag
						return {
							specName: entry,
							path: entryPath,
							branch: "",
							baseBranch: "",
							commitCount: 0,
							filesChanged: 0,
							additions: 0,
							deletions: 0,
							isOrphaned: taskLookupSuccessful ? !hasTask : false,
						};
					}
				};

				// Scan worktrees directory (async)
				if (!existsSync(worktreesDir)) {
					return { success: true, data: { worktrees: [] } };
				}

				const entries = await fsPromises.readdir(worktreesDir);

				// Process all worktrees in parallel for better performance
				const worktreePromises = entries.map(async (entry) => {
					const entryPath = path.join(worktreesDir, entry);
					try {
						const stat = await fsPromises.stat(entryPath);
						if (stat.isDirectory()) {
							return processWorktreeEntry(entry, entryPath);
						}
					} catch {
						// Skip entries that can't be stat'd
					}
					return null;
				});

				const results = await Promise.all(worktreePromises);
				const worktrees = results.filter(
					(w): w is WorktreeListItem => w !== null,
				);

				return { success: true, data: { worktrees } };
			} catch (error) {
				console.error("Failed to list worktrees:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to list worktrees",
				};
			}
		},
	);

	/**
	 * Detect installed IDEs and terminals on the system
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS,
		async (): Promise<IPCResult<DetectedTools>> => {
			try {
				const tools = await detectInstalledTools();
				return { success: true, data: tools };
			} catch (error) {
				console.error("Failed to detect tools:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to detect installed tools",
				};
			}
		},
	);


	/**
	 * Open a worktree directory in the specified IDE
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE,
		async (
			_,
			worktreePath: string,
			ide: SupportedIDE,
		): Promise<IPCResult<{ opened: boolean }>> => {
			try {
				const dirPath = resolveOpenableDir(
					worktreePath,
					projectStore.getProjects().map((project) => project.path),
				);
				if (!dirPath) {
					return {
						success: false,
						error: "Path is not a folder of a known project",
					};
				}

				// The custom launcher is the user's setting, never a renderer value
				const customPath = readSettingsFile()?.customIDEPath;
				const result = await openInIDE(dirPath, ide, customPath as string);
				if (!result.success) {
					return { success: false, error: result.error };
				}

				return { success: true, data: { opened: true } };
			} catch (error) {
				console.error("Failed to open in IDE:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to open in IDE",
				};
			}
		},
	);

	/**
	 * Open a worktree directory in the specified terminal
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL,
		async (
			_,
			worktreePath: string,
			terminal: SupportedTerminal,
		): Promise<IPCResult<{ opened: boolean }>> => {
			try {
				const dirPath = resolveOpenableDir(
					worktreePath,
					projectStore.getProjects().map((project) => project.path),
				);
				if (!dirPath) {
					return {
						success: false,
						error: "Path is not a folder of a known project",
					};
				}

				// The custom launcher is the user's setting, never a renderer value
				const customPath = readSettingsFile()?.customTerminalPath;
				const result = await openInTerminal(
					dirPath,
					terminal,
					customPath as string,
				);
				if (!result.success) {
					return { success: false, error: result.error };
				}

				return { success: true, data: { opened: true } };
			} catch (error) {
				console.error("Failed to open in terminal:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to open in terminal",
				};
			}
		},
	);

	/**
	 * Clear the staged state for a task
	 * This allows the user to re-stage changes if needed
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CLEAR_STAGED_STATE,
		async (_, taskId: string): Promise<IPCResult<{ cleared: boolean }>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const specsBaseDir = getSpecsDir(project.autoBuildPath);
				const specDir = path.join(project.path, specsBaseDir, task.specId);
				const planPath = path.join(
					specDir,
					AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
				);

				// Use EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
				const { promises: fsPromises } = require("node:fs");
				const isFileNotFound = (err: unknown): boolean =>
					!!(
						err &&
						typeof err === "object" &&
						"code" in err &&
						err.code === "ENOENT"
					);

				// Read, update, and write the plan file
				let planContent: string;
				try {
					planContent = await fsPromises.readFile(planPath, "utf-8");
				} catch (readErr) {
					if (isFileNotFound(readErr)) {
						return { success: false, error: "Implementation plan not found" };
					}
					throw readErr;
				}

				const plan = JSON.parse(planContent);

				// Clear the staged state flags
				delete plan.stagedInMainProject;
				delete plan.stagedAt;
				plan.updated_at = new Date().toISOString();

				await fsPromises.writeFile(
					planPath,
					JSON.stringify(plan, null, 2),
					"utf-8",
				);

				// Also update worktree plan if it exists
				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (worktreePath) {
					const worktreePlanPath = path.join(
						worktreePath,
						specsBaseDir,
						task.specId,
						AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
					);
					try {
						const worktreePlanContent = await fsPromises.readFile(
							worktreePlanPath,
							"utf-8",
						);
						const worktreePlan = JSON.parse(worktreePlanContent);
						delete worktreePlan.stagedInMainProject;
						delete worktreePlan.stagedAt;
						worktreePlan.updated_at = new Date().toISOString();
						await fsPromises.writeFile(
							worktreePlanPath,
							JSON.stringify(worktreePlan, null, 2),
							"utf-8",
						);
					} catch (e) {
						// Non-fatal - worktree plan update is best-effort
						// ENOENT is expected when worktree has no plan file
						if (!isFileNotFound(e)) {
							console.warn(
								"[CLEAR_STAGED_STATE] Failed to update worktree plan:",
								e,
							);
						}
					}
				}

				// Invalidate tasks cache to force reload
				projectStore.invalidateTasksCache(project.id);

				return { success: true, data: { cleared: true } };
			} catch (error) {
				console.error("Failed to clear staged state:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to clear staged state",
				};
			}
		},
	);



	/**
	 * Preview the PR body + impact analysis WITHOUT pushing or creating a PR.
	 * Used by the PR review modal to pre-fill editable fields (rating 1-5 +
	 * impacted features) before the user confirms creation.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_ANALYZE_IMPACT,
		async (
			_,
			taskId: string,
			targetBranch?: string,
		): Promise<
			IPCResult<import("../../../shared/types").WorktreeAnalyzeImpactResult>
		> => {
			try {
				const pythonEnvError = await initializePythonEnvForPR(pythonEnvManager);
				if (pythonEnvError) {
					return { success: false, error: pythonEnvError };
				}

				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const sourcePath = getEffectiveSourcePath();
				if (!sourcePath) {
					return { success: false, error: "WorkPilot AI source not found" };
				}

				const runScript = path.join(sourcePath, "run.py");

				const args: string[] = [
					runScript,
					"--spec",
					task.specId,
					"--project-dir",
					project.path,
					"--analyze-impact",
				];
				if (targetBranch) {
					if (!GIT_BRANCH_REGEX.test(targetBranch)) {
						return { success: false, error: "Invalid target branch name" };
					}
					args.push("--pr-target", targetBranch);
				}

				const pythonPath = getConfiguredPythonPath();
				const profileEnv = getBestAvailableProfileEnv().env;
				const projectEnv = loadProjectEnvForSubprocess(project);
				const pythonEnv = pythonEnvManagerSingleton.getPythonEnv();
				const ghCliPath = getToolPath("gh");
				const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonPath);

				return new Promise<
					IPCResult<
						import("../../../shared/types").WorktreeAnalyzeImpactResult
					>
				>((resolve) => {
					const proc = spawn(
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
					let resolved = false;

					// LLM analysis can take a while; give it 60s.
					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						killProcessGracefully(proc, {
							debugPrefix: "[ANALYZE_IMPACT]",
							debug: false,
						});
						resolve({
							success: false,
							error: "Impact analysis timed out after 60s",
						});
					}, 60_000);

					proc.stdout.on("data", (d: Buffer) => {
						stdout += d.toString("utf-8");
					});
					proc.stderr.on("data", (d: Buffer) => {
						stderr += d.toString("utf-8");
					});

					const onExit = (code: number | null) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);

						// Parse the last JSON line from stdout (CLI prints banner +
						// progress lines before the final JSON).
						const trimmed = stdout.trim();
						const lines = trimmed
							.split(/\r?\n/)
							.map((l) => l.trim())
							.filter(Boolean);
						let parsed: Record<string, unknown> | null = null;
						for (let i = lines.length - 1; i >= 0; i--) {
							const line = lines[i];
							if (line.startsWith("{") && line.endsWith("}")) {
								try {
									parsed = JSON.parse(line) as Record<string, unknown>;
									break;
								} catch {
									// keep looking
								}
							}
						}

						if (parsed && parsed.success === true) {
							resolve({
								success: true,
								data: {
									success: true,
									body: typeof parsed.body === "string" ? parsed.body : "",
									rating:
										typeof parsed.rating === "string"
											? parsed.rating
											: "N/A",
									features:
										typeof parsed.features === "string"
											? parsed.features
											: "Non evalue",
								},
							});
							return;
						}

						const err =
							(parsed && typeof parsed.error === "string"
								? parsed.error
								: undefined) ||
							stderr.trim() ||
							`Impact analysis failed (exit code ${code})`;
						resolve({ success: false, error: err });
					};

					proc.on("close", (code) => onExit(code));
					proc.on("error", (err) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve({
							success: false,
							error: `Failed to run analyze-impact: ${err.message}`,
						});
					});
				});
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to analyze impact",
				};
			}
		},
	);

	/**
	 * Merge or rebase the worktree branch from any specified source branch.
	 * Useful for pulling in changes that landed on the base/main branch after the task was created.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_SYNC_FROM_BRANCH,
		async (
			_,
			taskId: string,
			sourceBranch: string,
			strategy: "merge" | "rebase",
		): Promise<
			IPCResult<import("../../../shared/types").WorktreeSyncResult>
		> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (!worktreePath) {
					return {
						success: false,
						error:
							"No worktree found for this task. The task must be running or in review.",
					};
				}

				// Validate branch name
				if (!sourceBranch || !GIT_BRANCH_REGEX.test(sourceBranch)) {
					return {
						success: false,
						error: `Invalid branch name: ${sourceBranch}`,
					};
				}

				const git = getToolPath("git");
				const isolatedEnv = getIsolatedGitEnv();

				// Fetch latest refs in the main project so the branch ref is up-to-date
				try {
					spawnSync(git, ["fetch", "--prune"], {
						cwd: project.path,
						encoding: "utf-8",
						env: isolatedEnv,
						timeout: 30000,
					});
				} catch {
					// Fetch failure is non-fatal (e.g. offline) — continue with local refs
				}

				// Run merge or rebase in the worktree
				const gitArgs =
					strategy === "rebase"
						? ["rebase", sourceBranch]
						: ["merge", "--no-edit", sourceBranch];

				const result = spawnSync(git, gitArgs, {
					cwd: worktreePath,
					encoding: "utf-8",
					env: isolatedEnv,
					timeout: 60000,
				});

				if (result.status === 0) {
					return {
						success: true,
						data: {
							success: true,
							message:
								strategy === "rebase"
									? `Worktree successfully rebased onto ${sourceBranch}`
									: `${sourceBranch} successfully merged into worktree`,
						},
					};
				}

				// Non-zero exit — check for conflicts
				const output = (result.stdout || "") + (result.stderr || "");
				const conflictLines = output
					.split("\n")
					.filter((l) => l.startsWith("CONFLICT") || l.includes("conflict"))
					.map((l) => l.replace(/^CONFLICT \([^)]+\):\s*/, "").trim())
					.filter(Boolean);

				// Abort the failed operation to restore the worktree to a clean state
				try {
					const abortArgs =
						strategy === "rebase"
							? ["rebase", "--abort"]
							: ["merge", "--abort"];
					spawnSync(git, abortArgs, {
						cwd: worktreePath,
						encoding: "utf-8",
						env: isolatedEnv,
						timeout: 15000,
					});
				} catch {
					// Abort failure is non-fatal
				}

				if (conflictLines.length > 0) {
					return {
						success: false,
						error: `${strategy === "rebase" ? "Rebase" : "Merge"} resulted in conflicts. Resolve them manually in the worktree.`,
						data: {
							success: false,
							message: `Conflicts detected with ${sourceBranch}`,
							hasConflicts: true,
							conflictFiles: conflictLines,
						},
					};
				}

				return {
					success: false,
					error:
						stripAnsiCodes(output.trim()) ||
						`${strategy} failed with exit code ${result.status}`,
				};
			} catch (error) {
				console.error("[SYNC_FROM_BRANCH] Exception:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Sync failed",
				};
			}
		},
	);
}
