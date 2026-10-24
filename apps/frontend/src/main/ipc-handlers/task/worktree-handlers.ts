import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	promises as fsPromises,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app, type BrowserWindow, ipcMain } from "electron";
import { minimatch } from "minimatch";
import {
	AUTO_BUILD_PATHS,
	DEFAULT_APP_SETTINGS,
	DEFAULT_FEATURE_MODELS,
	DEFAULT_FEATURE_THINKING,
	getSpecsDir,
	IPC_CHANNELS,
	MODEL_ID_MAP,
	THINKING_BUDGET_MAP,
} from "../../../shared/constants";
import type {
	AppSettings,
	IPCResult,
	SupportedIDE,
	SupportedTerminal,
	TaskStatus,
	WorktreeCreatePROptions,
	WorktreeCreatePRResult,
	WorktreeDiff,
	WorktreeDiffFile,
	WorktreeDiscardResult,
	WorktreeListItem,
	WorktreeListResult,
	WorktreeMergeResult,
	WorktreeStatus,
	VisualProofRun,
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
import { getIsolatedGitEnv, refreshGitIndex } from "../../utils/git-isolation";
import { cleanupWorktree } from "../../utils/worktree-cleanup";
import { visualProofService } from "../../visual-proof-service";
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
	getTaskBaseBranch,
	getEffectiveBaseBranch,
	detectGitDefaultBranch,
	resolveDiffRefs,
} from "./worktree-git-refs";
import {
	loadProjectEnvForSubprocess,
	parsePRJsonOutput,
	updateTaskStatusAfterPRCreation,
	updateVisualProofMetadata,
	persistTaskPrUrl,
	detectExistingPrUrl,
	buildCreatePRArgs,
	initializePythonEnvForPR,
	withRetry,
} from "./worktree-pr-helpers";
// Moved to ./worktree-git-refs.ts (audit lot L11, F36); re-exported for existing importers.
export { GIT_BRANCH_REGEX, validateWorktreeBranch } from "./worktree-git-refs";

/**
 * Extract the last well-formed JSON object found in a multi-line stdout
 * blob. The Python backend interleaves DEBUG log lines with its final
 * `print(json.dumps(result))`, so JSON.parse on the whole stream fails.
 *
 * Walks the lines bottom-up, returns the first one that parses as an
 * object (not a primitive). Returns null when no parseable object is
 * found — callers should treat that as an error.
 */
function extractLastJsonObject(stdout: string): Record<string, unknown> | null {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Not valid JSON on this line — keep walking up.
		}
	}
	return null;
}

// Timeout for PR creation operations (2 minutes for network operations)
const PR_CREATION_TIMEOUT_MS = 120000;

/**
 * Read utility feature settings (for commit message, merge resolver) from settings file
 */
function getUtilitySettings(): {
	model: string;
	modelId: string;
	thinkingLevel: string;
	thinkingBudget: number | null;
} {
	const settingsPath = path.join(app.getPath("userData"), "settings.json");

	try {
		if (existsSync(settingsPath)) {
			const content = readFileSync(settingsPath, "utf-8");
			const settings: AppSettings = {
				...DEFAULT_APP_SETTINGS,
				...JSON.parse(content),
			};

			// Get utility-specific settings
			const featureModels = settings.featureModels || DEFAULT_FEATURE_MODELS;
			const featureThinking =
				settings.featureThinking || DEFAULT_FEATURE_THINKING;

			const model = featureModels.utility || DEFAULT_FEATURE_MODELS.utility;
			const thinkingLevel =
				featureThinking.utility || DEFAULT_FEATURE_THINKING.utility;

			return {
				model,
				modelId: MODEL_ID_MAP[model] || MODEL_ID_MAP.haiku,
				thinkingLevel,
				thinkingBudget:
					thinkingLevel in THINKING_BUDGET_MAP
						? THINKING_BUDGET_MAP[thinkingLevel]
						: THINKING_BUDGET_MAP.low,
			};
		}
	} catch (error) {
		// Log parse errors to help diagnose corrupted settings
		console.warn("[getUtilitySettings] Failed to parse settings.json:", error);
	}

	// Return defaults if settings file doesn't exist or fails to parse
	return {
		model: DEFAULT_FEATURE_MODELS.utility,
		modelId: MODEL_ID_MAP[DEFAULT_FEATURE_MODELS.utility],
		thinkingLevel: DEFAULT_FEATURE_THINKING.utility,
		thinkingBudget: THINKING_BUDGET_MAP[DEFAULT_FEATURE_THINKING.utility],
	};
}

/**
 * Check if a repository is misconfigured as bare but has source files.
 * If so, automatically fix the configuration by unsetting core.bare.
 *
 * This can happen when git worktree operations incorrectly set bare=true,
 * or when users manually misconfigure the repository.
 *
 * @param projectPath - Path to check and potentially fix
 * @returns true if fixed, false if no fix needed or not fixable
 */
function fixMisconfiguredBareRepo(projectPath: string): boolean {
	try {
		// Check if bare=true is set
		const bareConfig = execFileSync(
			getToolPath("git"),
			["config", "--get", "core.bare"],
			{ cwd: projectPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		)
			.trim()
			.toLowerCase();

		if (bareConfig !== "true") {
			return false; // Not marked as bare, nothing to fix
		}

		// Check if there are source files (indicating misconfiguration)
		// A truly bare repo would only have git internals, not source code
		// This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
		//
		// Markers are separated into exact matches and glob patterns for efficiency.
		// Exact matches use existsSync() directly, while glob patterns use minimatch
		// against a cached directory listing.
		const EXACT_MARKERS = [
			// JavaScript/TypeScript ecosystem
			"package.json",
			"apps",
			"src",
			// Python ecosystem
			"pyproject.toml",
			"setup.py",
			"requirements.txt",
			"Pipfile",
			// Rust ecosystem
			"Cargo.toml",
			// Go ecosystem
			"go.mod",
			"go.sum",
			"cmd",
			"main.go",
			// Java/JVM ecosystem
			"pom.xml",
			"build.gradle",
			"build.gradle.kts",
			// Ruby ecosystem
			"Gemfile",
			"Rakefile",
			// PHP ecosystem
			"composer.json",
			// General project markers
			"Makefile",
			"CMakeLists.txt",
			"README.md",
			"LICENSE",
		];

		const GLOB_MARKERS = [
			// .NET/C# ecosystem - patterns that need glob matching
			"*.csproj",
			"*.sln",
			"*.fsproj",
		];

		// Check exact matches first (fast path)
		const hasExactMatch = EXACT_MARKERS.some((marker) =>
			existsSync(path.join(projectPath, marker)),
		);

		if (hasExactMatch) {
			// Found a project marker, proceed to fix
		} else {
			// Check glob patterns - read directory once and cache for all patterns
			let directoryFiles: string[] | null = null;
			const MAX_FILES_TO_CHECK = 500; // Limit to avoid reading huge directories

			const hasGlobMatch = GLOB_MARKERS.some((pattern) => {
				// Validate pattern - only support simple glob patterns for security
				if (pattern.includes("..") || pattern.includes("/")) {
					console.warn(`[GIT] Unsupported glob pattern ignored: ${pattern}`);
					return false;
				}

				// Lazy-load directory listing, cached across patterns
				if (directoryFiles === null) {
					try {
						const allFiles = readdirSync(projectPath);
						// Limit to first N entries to avoid performance issues
						directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
						if (allFiles.length > MAX_FILES_TO_CHECK) {
							console.warn(
								`[GIT] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`,
							);
						}
					} catch (error) {
						// Log the error for debugging instead of silently swallowing
						console.warn(
							`[GIT] Failed to read directory ${projectPath}:`,
							error instanceof Error ? error.message : String(error),
						);
						directoryFiles = [];
					}
				}

				// Use minimatch for proper glob pattern matching
				return directoryFiles.some((file) =>
					minimatch(file, pattern, { nocase: true }),
				);
			});

			if (!hasGlobMatch) {
				return false; // Legitimately bare repo
			}
		}

		// Fix the misconfiguration
		console.warn(
			"[GIT] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...",
		);
		execFileSync(getToolPath("git"), ["config", "--unset", "core.bare"], {
			cwd: projectPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		console.warn(
			"[GIT] Fixed: core.bare has been unset. Git operations should now work correctly.",
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a path is a valid git working tree (not a bare repository).
 * Returns true if the path is inside a git repository with a working tree.
 *
 * NOTE: This is a pure check with no side-effects. If you need to fix
 * misconfigured bare repos before an operation, call fixMisconfiguredBareRepo()
 * explicitly before calling this function.
 *
 * @param projectPath - Path to check
 * @returns true if it's a valid working tree, false if bare or not a git repo
 */
function isGitWorkTree(projectPath: string): boolean {
	try {
		// Use git rev-parse --is-inside-work-tree which returns "true" for working trees
		// and fails for bare repos or non-git directories
		const result = execFileSync(
			getToolPath("git"),
			["rev-parse", "--is-inside-work-tree"],
			{ cwd: projectPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return result.trim() === "true";
	} catch {
		// Not a working tree (could be bare repo or not a git repo at all)
		return false;
	}
}

/**
 * Register worktree management handlers
 */
export function registerWorktreeHandlers(
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
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
	 * Get the diff for a task's worktree
	 * Per-spec architecture: Each spec has its own worktree at .workpilot/worktrees/tasks/{spec-name}/
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DIFF,
		async (_, taskId: string): Promise<IPCResult<WorktreeDiff>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Find worktree at .workpilot/worktrees/tasks/{spec-name}/
				const worktreePath = findTaskWorktree(project.path, task.specId);

				if (!worktreePath) {
					return { success: false, error: "No worktree found for this task" };
				}

				// Get base branch using proper fallback chain:
				// 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
				// Note: We do NOT use current HEAD as that may be a feature branch
				const baseBranch = getEffectiveBaseBranch(
					project.path,
					task.specId,
					project.settings?.mainBranch,
				);

				// Récupère la branche du worktree pour pouvoir préférer
				// `origin/<branch>` quand elle existe (alignement avec la PR).
				let worktreeBranch = "HEAD";
				try {
					worktreeBranch = execFileSync(
						getToolPath("git"),
						["rev-parse", "--abbrev-ref", "HEAD"],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();
				} catch {
					// fallback à HEAD - resolveDiffRefs gérera l'absence de origin/
				}
				const diffRefs = resolveDiffRefs(
					worktreePath,
					worktreeBranch,
					baseBranch,
				);
				const diffRange = `${diffRefs.baseRef}...${diffRefs.headRef}`;

				// Get the diff with file stats
				const files: WorktreeDiffFile[] = [];

				try {
					// Single atomic git call: status, stats and patch all come from the
					// same snapshot, preventing a race where separate numstat/fullDiff
					// invocations could see different HEAD commits on an
					// actively-committing worktree (causing additions > 0 but patch = "").
					const fullDiff = execFileSync(
						getToolPath("git"),
						["diff", diffRange],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();

					// Split into per-file sections by walking the diff line by line.
					const sections: string[] = [];
					let currentLines: string[] = [];
					for (const line of fullDiff.split("\n")) {
						if (line.startsWith("diff --git ")) {
							if (currentLines.length > 0) sections.push(currentLines.join("\n"));
							currentLines = [line];
						} else {
							currentLines.push(line);
						}
					}
					if (currentLines.length > 0) sections.push(currentLines.join("\n"));

					for (const section of sections) {
						const headerMatch = section.match(/^diff --git a\/(.*) b\/(.*)$/m);
						if (!headerMatch) continue;

						// Use the b/ (destination) path as canonical — correct for renames too.
						const filePath = headerMatch[2];

						let status: "added" | "modified" | "deleted" | "renamed" =
							"modified";
						if (/^new file mode/m.test(section)) status = "added";
						else if (/^deleted file mode/m.test(section)) status = "deleted";
						else if (/^rename from /m.test(section)) status = "renamed";

						// Count additions/deletions from the same content as the patch.
						let additions = 0;
						let deletions = 0;
						for (const line of section.split("\n")) {
							if (line.startsWith("+") && !line.startsWith("+++")) additions++;
							else if (line.startsWith("-") && !line.startsWith("---"))
								deletions++;
						}

						files.push({
							path: filePath,
							status,
							additions,
							deletions,
							patch: section || undefined,
						});
					}
				} catch (diffError) {
					console.error("Error getting diff:", diffError);
				}

				// Load and apply discard list filter
				const discardListPath = path.join(
					worktreePath,
					".workpilot-discard-list",
				);
				let discardedFiles: string[] = [];
				try {
					const content = await fsPromises.readFile(
						discardListPath,
						"utf-8",
					);
					discardedFiles = content
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line && !line.startsWith("#"));
					if (discardedFiles.length > 0) {
						console.error(
							`[TASK_WORKTREE_DIFF] Loaded ${discardedFiles.length} discarded files:`,
							discardedFiles,
						);
					}
				} catch (err) {
					// .workpilot-discard-list est optionnel : ENOENT est normal
					// quand l'utilisateur n'a discardé aucun fichier. Seuls les
					// autres types d'erreur (permissions, EIO…) sont remontés.
					const isMissing =
						err instanceof Error &&
						(err as NodeJS.ErrnoException).code === "ENOENT";
					if (!isMissing) {
						console.error(
							"[TASK_WORKTREE_DIFF] Error reading discard list:",
							err,
						);
					}
				}

				// Filter out discarded files from the diff
				const isWorkpilotArtifact = (p: string): boolean => {
					const normalized = p.replaceAll("\\", "/");
					return (
						normalized === ".workpilot" ||
						normalized.startsWith(".workpilot/") ||
						normalized.startsWith(".workpilot-")
					);
				};
				const filteredFiles = files.filter(
					(file) =>
						!discardedFiles.includes(file.path) &&
						!isWorkpilotArtifact(file.path),
				);
				if (discardedFiles.length > 0) {
					console.error(
						`[TASK_WORKTREE_DIFF] Filtered from ${files.length} to ${filteredFiles.length} files`,
					);
				}

				// Generate summary
				const totalAdditions = filteredFiles.reduce(
					(sum, f) => sum + f.additions,
					0,
				);
				const totalDeletions = filteredFiles.reduce(
					(sum, f) => sum + f.deletions,
					0,
				);
				const summary = `${filteredFiles.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`;

				return {
					success: true,
					data: { files: filteredFiles, summary },
				};
			} catch (error) {
				console.error("Failed to get worktree diff:", error);
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to get worktree diff",
				};
			}
		},
	);

	/**
	 * Get the diff for a single impacted file, on demand.
	 *
	 * Contrairement à TASK_WORKTREE_DIFF (qui n'expose que les changements
	 * commités via `base...head`), ce handler tente plusieurs stratégies afin de
	 * toujours pouvoir montrer les lignes modifiées d'un fichier impacté :
	 *   1. plage commitée `base...head`,
	 *   2. changements non commités vs `HEAD`,
	 *   3. arbre de travail vs index,
	 *   4. fichier non suivi (synthétise un patch « ajouté »).
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_FILE_DIFF,
		async (
			_,
			taskId: string,
			filePath: string,
		): Promise<IPCResult<WorktreeDiffFile>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				const worktreePath = findTaskWorktree(project.path, task.specId);
				if (!worktreePath) {
					return { success: false, error: "No worktree found for this task" };
				}

				// Normalise et protège contre la traversée de chemin.
				const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
				if (
					!normalized ||
					normalized.split("/").some((segment) => segment === "..")
				) {
					return { success: false, error: "Invalid file path" };
				}

				const git = getToolPath("git");
				const runGit = (args: string[]): string => {
					try {
						return execFileSync(git, args, {
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						}).trim();
					} catch {
						return "";
					}
				};

				const baseBranch = getEffectiveBaseBranch(
					project.path,
					task.specId,
					project.settings?.mainBranch,
				);
				let worktreeBranch = "HEAD";
				try {
					worktreeBranch = execFileSync(
						git,
						["rev-parse", "--abbrev-ref", "HEAD"],
						{
							cwd: worktreePath,
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
						},
					).trim();
				} catch {
					// fallback à HEAD
				}
				const diffRefs = resolveDiffRefs(
					worktreePath,
					worktreeBranch,
					baseBranch,
				);
				const diffRange = `${diffRefs.baseRef}...${diffRefs.headRef}`;

				const parseStatus = (
					nameStatus: string,
				): WorktreeDiffFile["status"] => {
					const first = nameStatus.split("\n").filter(Boolean)[0];
					switch (first?.[0]) {
						case "A":
							return "added";
						case "D":
							return "deleted";
						case "R":
							return "renamed";
						default:
							return "modified";
					}
				};
				const parseNumstat = (
					numstat: string,
				): { additions: number; deletions: number } => {
					const first = numstat.split("\n").filter(Boolean)[0];
					if (!first) return { additions: 0, deletions: 0 };
					const [adds, dels] = first.split("\t");
					return {
						additions: Number.parseInt(adds, 10) || 0,
						deletions: Number.parseInt(dels, 10) || 0,
					};
				};

				const tryDiff = (spec: string[]): WorktreeDiffFile | null => {
					const patch = runGit(["diff", ...spec, "--", normalized]);
					if (!patch) return null;
					const numstat = runGit([
						"diff",
						...spec,
						"--numstat",
						"--",
						normalized,
					]);
					const nameStatus = runGit([
						"diff",
						...spec,
						"--name-status",
						"--",
						normalized,
					]);
					const { additions, deletions } = parseNumstat(numstat);
					return {
						path: normalized,
						status: parseStatus(nameStatus),
						additions,
						deletions,
						patch,
					};
				};

				let result =
					tryDiff([diffRange]) ?? tryDiff(["HEAD"]) ?? tryDiff([]);

				// Fichier non suivi : git diff ne renvoie rien → patch synthétique.
				if (!result) {
					const porcelain = runGit([
						"status",
						"--porcelain",
						"--",
						normalized,
					]);
					if (porcelain.startsWith("??")) {
						const content = await fsPromises
							.readFile(path.join(worktreePath, normalized), "utf-8")
							.catch(() => "");
						const lines = content.split("\n");
						const body = lines.map((line) => `+${line}`).join("\n");
						result = {
							path: normalized,
							status: "added",
							additions: lines.length,
							deletions: 0,
							patch:
								`diff --git a/${normalized} b/${normalized}\n` +
								`--- /dev/null\n+++ b/${normalized}\n` +
								`@@ -0,0 +1,${lines.length} @@\n${body}`,
						};
					}
				}

				// Aucun changement détecté : réponse neutre (l'UI affiche « no diff »).
				if (!result) {
					return {
						success: true,
						data: {
							path: normalized,
							status: "modified",
							additions: 0,
							deletions: 0,
							patch: undefined,
						},
					};
				}

				return { success: true, data: result };
			} catch (error) {
				console.error("Failed to get file diff:", error);
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to get file diff",
				};
			}
		},
	);

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
	 * Read a file from a worktree
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_READ_FILE,
		async (
			_,
			worktreePath: string,
			relativePath: string,
		): Promise<IPCResult<string>> => {
			try {
				const fullPath = path.join(worktreePath, relativePath);
				const resolved = path.resolve(fullPath);
				const resolvedWorktree = path.resolve(worktreePath);

				// Security: ensure the resolved path is still inside the worktree
				if (!resolved.startsWith(resolvedWorktree)) {
					return { success: false, error: "Path traversal not allowed" };
				}

				const content = await fsPromises.readFile(resolved, "utf-8");
				return { success: true, data: content };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to read file",
				};
			}
		},
	);

	/**
	 * Write a file to a worktree
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE,
		async (
			_,
			worktreePath: string,
			relativePath: string,
			content: string,
		): Promise<IPCResult<{ written: boolean }>> => {
			try {
				const fullPath = path.join(worktreePath, relativePath);
				const resolved = path.resolve(fullPath);
				const resolvedWorktree = path.resolve(worktreePath);

				// Security: ensure the resolved path is still inside the worktree
				if (!resolved.startsWith(resolvedWorktree)) {
					return { success: false, error: "Path traversal not allowed" };
				}

				// Ensure parent directory exists
				await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
				await fsPromises.writeFile(resolved, content, "utf-8");

				return { success: true, data: { written: true } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to write file",
				};
			}
		},
	);

	/**
	 * Discard changes to files in a worktree (git checkout)
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_WORKTREE_DELETE_FILES,
		async (
			_,
			worktreePath: string,
			relativePaths: string[],
		): Promise<IPCResult<{ deleted: string[]; failed: string[] }>> => {
			const deleted: string[] = [];
			const failed: string[] = [];
			const resolvedWorktree = path.resolve(worktreePath);
			// Discarding means "restore this file to the base branch's version".
			// Which branch that is depends on the project — never assume one.
			const baseBranch = detectGitDefaultBranch(resolvedWorktree);
			const gitPath = getToolPath("git");

			// Load existing discard list
			const discardListPath = path.join(
				resolvedWorktree,
				".workpilot-discard-list",
			);
			let discardedFiles: string[] = [];
			try {
				const content = await fsPromises.readFile(discardListPath, "utf-8");
				discardedFiles = content
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"));
			} catch {
				// File doesn't exist yet
			}

			for (const relativePath of relativePaths) {
				try {
					// Security: validate path stays within worktree
					const fullPath = path.join(resolvedWorktree, relativePath);
					const resolved = path.resolve(fullPath);
					const relative = path.relative(resolvedWorktree, resolved);
					if (relative.startsWith("..")) {
						failed.push(relativePath);
						continue;
					}

					// Discard changes: sync file state with the base branch.
					// execFileAsync (argv array), NOT a shell template string:
					// `relativePath` is a filename from the repo, and the
					// containment check above says nothing about shell
					// metacharacters. A file named `a" & calc & ".txt` in a
					// cloned repo would otherwise run as a command here.
					const statusResult = await execFileAsync(
						gitPath,
						["status", "--porcelain", "--", relativePath],
						{ cwd: resolvedWorktree },
					);
					const statusOutput = statusResult.stdout.trim();

					if (statusOutput.startsWith("??")) {
						// Untracked file, just remove it
						try {
							await fsPromises.unlink(resolved);
						} catch (err) {
							// Ignore if file doesn't exist
							if (
								!(err instanceof Error) ||
								!err.message.includes("ENOENT")
							) {
								throw err;
							}
						}
					} else if (statusOutput) {
						// File is tracked: reset to the base branch's version
						await execFileAsync(
							gitPath,
							["reset", baseBranch, "--", relativePath],
							{ cwd: resolvedWorktree },
						);
						// Then checkout the file from the base branch to match exactly
						await execFileAsync(
							gitPath,
							["checkout", baseBranch, "--", relativePath],
							{ cwd: resolvedWorktree },
						);
					}

					// Add to discard list so backend excludes it from merge preview
					if (!discardedFiles.includes(relativePath)) {
						discardedFiles.push(relativePath);
					}

					deleted.push(relativePath);
				} catch (error) {
					console.error(
						`[WORKTREE_DISCARD] Failed to discard changes to ${relativePath}:`,
						error,
					);
					failed.push(relativePath);
				}
			}

			// Write discard list for backend to read
			if (discardedFiles.length > 0) {
				await fsPromises.writeFile(
					discardListPath,
					discardedFiles
						.map((f) => f.trim())
						.join("\n")
						.concat("\n"),
					"utf-8",
				);
			}

			return { success: true, data: { deleted, failed } };
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
												IPC_CHANNELS.TASK_UPDATE,
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

	/**
	 * Run or retry automated visual proof.
	 *
	 * A PR is no longer required: when the task has no PR URL yet, the run still
	 * captures, stores and displays screenshots locally. GitHub blob URLs and the
	 * PR comment are attached only when a PR URL is known — otherwise they are
	 * added later by {@link IPC_CHANNELS.TASK_VISUAL_PROOF_SYNC} once a PR is
	 * detected on the branch.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_RUN,
		async (_, taskId: string): Promise<IPCResult<VisualProofRun>> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// May be undefined — a run without a PR is now supported.
				const prUrl = task.prUrl ?? task.metadata?.prUrl;

				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);
				const worktreePath = findTaskWorktree(project.path, task.specId);
				const visualProof = await visualProofService.run({
					taskId: task.id,
					projectPath: project.path,
					specId: task.specId,
					prUrl,
					worktreePath: worktreePath ?? undefined,
					autoBuildPath: project.autoBuildPath,
				});

				updateVisualProofMetadata(
					specDir,
					worktreePath,
					project.autoBuildPath,
					task.specId,
					visualProof,
					(...args: unknown[]) => console.warn("[VISUAL_PROOF]", ...args),
				);

				const mainWindow = getMainWindow();
				if (mainWindow) {
					mainWindow.webContents.send(
						IPC_CHANNELS.TASK_UPDATE,
						task.id,
						{ metadata: { visualProof } },
						project.id,
					);
				}

				return { success: true, data: visualProof };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error ? error.message : "Failed to run visual proof",
				};
			}
		},
	);

	/**
	 * Sync stored visual-proof captures to a PR once one exists.
	 *
	 * The renderer calls this when the Visual Proof tab opens and after each run:
	 * if the task is not yet linked to a PR, we probe the branch for an existing
	 * PR (created any way — WorkPilot, gh, git, the web UI). When one is found we
	 * persist its URL onto the task and publish the already-captured screenshots
	 * to it (GitHub blob URLs + proof comment). No emulator is launched and no PR
	 * is ever created here.
	 *
	 * Returns `{ prUrl?, visualProof? }`: both absent means "no PR yet" (not an
	 * error). The renderer merges the result into its task metadata.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_SYNC,
		async (
			_,
			taskId: string,
		): Promise<
			IPCResult<{ prUrl?: string; visualProof?: VisualProofRun }>
		> => {
			try {
				const { task, project } = findTaskAndProject(taskId);
				if (!task || !project) {
					return { success: false, error: "Task not found" };
				}

				// Already linked to a PR: nothing to sync.
				if (task.prUrl ?? task.metadata?.prUrl) {
					return { success: true, data: {} };
				}

				const specDir = path.join(
					project.path,
					project.autoBuildPath || ".workpilot",
					"specs",
					task.specId,
				);
				const worktreePath = findTaskWorktree(project.path, task.specId);

				const prUrl = await detectExistingPrUrl(
					pythonEnvManager,
					project,
					task.specId,
					getTaskBaseBranch(specDir),
				);
				if (!prUrl) {
					// No PR on the branch yet — expected, not a failure.
					return { success: true, data: {} };
				}

				// Link the task to the freshly-detected PR (without forcing "done").
				persistTaskPrUrl(
					specDir,
					worktreePath,
					project.autoBuildPath,
					task.specId,
					prUrl,
				);

				// Publish any already-captured run to the PR.
				const existingProof = task.metadata?.visualProof;
				let visualProof: VisualProofRun | undefined;
				if (existingProof) {
					visualProof = await visualProofService.publishToPr(
						existingProof,
						prUrl,
						worktreePath ?? undefined,
					);
					updateVisualProofMetadata(
						specDir,
						worktreePath,
						project.autoBuildPath,
						task.specId,
						visualProof,
						(...args: unknown[]) => console.warn("[VISUAL_PROOF_SYNC]", ...args),
					);
				}

				return { success: true, data: { prUrl, visualProof } };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to sync visual proof",
				};
			}
		},
	);

	/**
	 * Report whether a visual proof run is currently in progress for a task. The
	 * renderer queries this on mount so the spinner is restored after the tab was
	 * closed/reopened, and so a second run cannot be triggered while one is live.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_VISUAL_PROOF_STATUS,
		async (_, taskId: string): Promise<IPCResult<{ running: boolean }>> => {
			return {
				success: true,
				data: { running: visualProofService.isRunning(taskId) },
			};
		},
	);

	// Forward visual proof start/finish to the renderer so every open tab can keep
	// its spinner in sync, even one that did not initiate the run. Registered once
	// (registerWorktreeHandlers runs at startup) to avoid stacking listeners.
	if (visualProofService.listenerCount("running-changed") === 0) {
		visualProofService.on(
			"running-changed",
			(taskId: string, running: boolean) => {
				getMainWindow()?.webContents.send(
					IPC_CHANNELS.TASK_VISUAL_PROOF_RUNNING,
					taskId,
					running,
				);
			},
		);
	}

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
