/**
 * Creating a task's pull request: the gh arguments, parsing its answer, finding a
 * PR that already exists, and recording the result on the task. Split out of
 * worktree-handlers.ts (audit lot L11, F36).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import type {
	WorktreeCreatePROptions,
	VisualProofRun,
} from "../../../shared/types";
import { getAppLanguage } from "../../app-language";
import { getToolPath } from "../../cli-tool-manager";
import { killProcessGracefully } from "../../platform";
import { readProjectEnv } from "../../project-env-file";
import { parsePythonCommand } from "../../python-detector";
import {
	getConfiguredPythonPath,
	type PythonEnvManager,
	pythonEnvManager as pythonEnvManagerSingleton,
} from "../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../rate-limit-detector";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { getIsolatedGitEnv } from "../../utils/git-isolation";
import {
	persistPlanStatus,
	updateTaskMetadataPrUrl,
	updateTaskMetadataVisualProof,
} from "./plan-file-utils";
import { GIT_BRANCH_REGEX } from "./worktree-git-refs";

/**
 * Load the project's `.workpilot/.env` and return it as a flat key→value
 * map suitable for injecting into a Python subprocess via `env: { ... }`.
 *
 * Why this exists: PR creation (and similar AzDO/Jira/GitHub operations)
 * needs to forward `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG_URL`,
 * `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_REPO`, `GITHUB_TOKEN`, etc. to
 * the Python subprocess. The PAT is stored in the per-project .env file,
 * not in the Electron main process env, so the subprocess would see an
 * empty `os.environ.get("AZURE_DEVOPS_PAT")` without this helper.
 *
 * Returns an empty object when the file is missing or unreadable — the
 * caller can still spawn the subprocess; auth-required operations will
 * fail downstream with their own error.
 */
export function loadProjectEnvForSubprocess(
	project: { path: string; autoBuildPath?: string | null },
): Record<string, string> {
	return readProjectEnv(project);
}

// Maximum PR title length (GitHub's limit is 256 characters)
export const MAX_PR_TITLE_LENGTH = 256;

// Regex for validating PR title contains only printable characters
export const PRINTABLE_CHARS_REGEX = /^[\x20-\x7E\u00A0-\uFFFF]*$/;

// Timeout for the read-only "does a PR already exist?" probe. Shorter than
// creation: it is a single provider API/CLI query with no push.
export const PR_DETECTION_TIMEOUT_MS = 45000;

// ============================================
// Helper functions for TASK_WORKTREE_CREATE_PR
// ============================================

/**
 * Result of parsing JSON output from the create-pr Python script
 */
export interface ParsedPRResult {
	success: boolean;
	prUrl?: string;
	alreadyExists?: boolean;
	error?: string;
}

/**
 * Validate that a URL is a valid GitHub PR URL.
 * Supports both github.com and GitHub Enterprise instances (custom domains).
 * Only requires HTTPS protocol and non-empty hostname to allow any GH Enterprise URL.
 * @returns true if the URL is a valid HTTPS URL with a non-empty hostname
 */
export function isValidGitHubUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		// Only require HTTPS with non-empty hostname
		// This supports GH Enterprise instances with custom domains
		// The URL comes from gh CLI output which we trust to be valid
		return parsed.protocol === "https:" && parsed.hostname.length > 0;
	} catch {
		return false;
	}
}

/**
 * Parse JSON output from the create-pr Python script
 * Handles both snake_case and camelCase field names
 * @returns ParsedPRResult if valid JSON found, null otherwise
 */
export function parsePRJsonOutput(stdout: string): ParsedPRResult | null {
	// Find the last complete JSON object in stdout (non-greedy, handles multiple objects)
	const jsonMatches = stdout.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
	const jsonMatch =
		jsonMatches && jsonMatches.length > 0
			? jsonMatches[jsonMatches.length - 1]
			: null;

	if (!jsonMatch) {
		return null;
	}

	try {
		const parsed = JSON.parse(jsonMatch);

		// Validate parsed JSON has expected shape
		if (typeof parsed !== "object" || parsed === null) {
			return null;
		}

		// Extract and validate fields with proper type checking
		// Handle both snake_case (from Python) and camelCase field names
		// Default success to false to avoid masking failures when field is missing
		const rawPrUrl =
			typeof parsed.pr_url === "string"
				? parsed.pr_url
				: typeof parsed.prUrl === "string"
					? parsed.prUrl
					: undefined;

		// Validate PR URL is a valid GitHub URL for robustness
		const validatedPrUrl =
			rawPrUrl && isValidGitHubUrl(rawPrUrl) ? rawPrUrl : undefined;

		return {
			success: typeof parsed.success === "boolean" ? parsed.success : false,
			prUrl: validatedPrUrl,
			alreadyExists:
				typeof parsed.already_exists === "boolean"
					? parsed.already_exists
					: typeof parsed.alreadyExists === "boolean"
						? parsed.alreadyExists
						: undefined,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Result of updating task status after PR creation
 */
export interface TaskStatusUpdateResult {
	mainProjectStatus: boolean;
	mainProjectMetadata: boolean;
	worktreeStatus: boolean;
	worktreeMetadata: boolean;
}

export interface VisualProofMetadataUpdateResult {
	mainProjectMetadata: boolean;
	worktreeMetadata: boolean;
}

/**
 * Update task status and metadata after PR creation
 * Updates both main project and worktree locations
 * @returns Result object indicating which updates succeeded/failed
 */
export async function updateTaskStatusAfterPRCreation(
	specDir: string,
	worktreePath: string | null,
	prUrl: string,
	autoBuildPath: string | undefined,
	specId: string,
	debug: (...args: unknown[]) => void,
): Promise<TaskStatusUpdateResult> {
	const result: TaskStatusUpdateResult = {
		mainProjectStatus: false,
		mainProjectMetadata: false,
		worktreeStatus: false,
		worktreeMetadata: false,
	};

	const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
	const metadataPath = path.join(specDir, "task_metadata.json");

	// Await status persistence to ensure completion before resolving
	try {
		const persisted = await persistPlanStatus(planPath, "done");
		result.mainProjectStatus = persisted;
		debug("Main project status persisted to done:", persisted);
	} catch (err) {
		debug("Failed to persist main project status:", err);
	}

	// Update metadata with prUrl in main project
	result.mainProjectMetadata = updateTaskMetadataPrUrl(metadataPath, prUrl);
	debug(
		"Main project metadata updated with prUrl:",
		result.mainProjectMetadata,
	);

	// Also persist to WORKTREE location (worktree takes priority when loading tasks)
	// This ensures the status persists after refresh since getTasks() prefers worktree version
	if (worktreePath) {
		const specsBaseDir = getSpecsDir(autoBuildPath);
		const worktreePlanPath = path.join(
			worktreePath,
			specsBaseDir,
			specId,
			AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
		);
		const worktreeMetadataPath = path.join(
			worktreePath,
			specsBaseDir,
			specId,
			"task_metadata.json",
		);

		try {
			const persisted = await persistPlanStatus(worktreePlanPath, "done");
			result.worktreeStatus = persisted;
			debug("Worktree status persisted to done:", persisted);
		} catch (err) {
			debug("Failed to persist worktree status:", err);
		}

		result.worktreeMetadata = updateTaskMetadataPrUrl(
			worktreeMetadataPath,
			prUrl,
		);
		debug("Worktree metadata updated with prUrl:", result.worktreeMetadata);
	}

	return result;
}

export function updateVisualProofMetadata(
	specDir: string,
	worktreePath: string | null,
	autoBuildPath: string | undefined,
	specId: string,
	visualProof: VisualProofRun,
	debug: (...args: unknown[]) => void,
): VisualProofMetadataUpdateResult {
	const result: VisualProofMetadataUpdateResult = {
		mainProjectMetadata: false,
		worktreeMetadata: false,
	};
	const metadataPath = path.join(specDir, "task_metadata.json");
	result.mainProjectMetadata = updateTaskMetadataVisualProof(
		metadataPath,
		visualProof,
	);
	debug(
		"Main project metadata updated with visual proof:",
		result.mainProjectMetadata,
	);

	if (worktreePath) {
		const specsBaseDir = getSpecsDir(autoBuildPath);
		const worktreeMetadataPath = path.join(
			worktreePath,
			specsBaseDir,
			specId,
			"task_metadata.json",
		);
		result.worktreeMetadata = updateTaskMetadataVisualProof(
			worktreeMetadataPath,
			visualProof,
		);
		debug("Worktree metadata updated with visual proof:", result.worktreeMetadata);
	}

	return result;
}

/**
 * Persist a PR URL onto a task's metadata (spec dir + worktree), without
 * touching its status. Used by the visual-proof sync flow, which links an
 * already-completed task to a PR that appeared on the branch after the fact —
 * unlike {@link updateTaskStatusAfterPRCreation}, it must not force "done".
 */
export function persistTaskPrUrl(
	specDir: string,
	worktreePath: string | null,
	autoBuildPath: string | undefined,
	specId: string,
	prUrl: string,
): void {
	updateTaskMetadataPrUrl(path.join(specDir, "task_metadata.json"), prUrl);
	if (worktreePath) {
		const worktreeMetadataPath = path.join(
			worktreePath,
			getSpecsDir(autoBuildPath),
			specId,
			"task_metadata.json",
		);
		updateTaskMetadataPrUrl(worktreeMetadataPath, prUrl);
	}
}

/**
 * Detect an existing open PR/MR for a task's branch, read-only.
 *
 * Runs `run.py --find-pr`, which wraps `WorktreeManager.find_existing_pr_url`
 * (provider-aware: GitHub via gh, GitLab via glab, Azure DevOps via REST). This
 * lets the visual-proof sync flow discover a PR *regardless of how it was
 * created* (WorkPilot, gh, git, the Azure/GitHub web UI…). Never rejects:
 * resolves to the PR URL, or `null` when there is no PR yet or detection fails.
 */
export async function detectExistingPrUrl(
	pythonEnvManager: PythonEnvManager,
	project: { path: string; autoBuildPath?: string | null },
	specId: string,
	taskBaseBranch: string | undefined,
): Promise<string | null> {
	const pythonEnvError = await initializePythonEnvForPR(pythonEnvManager);
	if (pythonEnvError) return null;

	const sourcePath = getEffectiveSourcePath();
	if (!sourcePath) return null;
	const runScript = path.join(sourcePath, "run.py");

	const args = [
		runScript,
		"--spec",
		specId,
		"--project-dir",
		project.path,
		"--find-pr",
	];
	if (taskBaseBranch && GIT_BRANCH_REGEX.test(taskBaseBranch)) {
		args.push("--pr-target", taskBaseBranch);
	}

	const pythonPath = getConfiguredPythonPath();
	const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonPath);
	const pythonEnv = pythonEnvManagerSingleton.getPythonEnv();
	const profileEnv = getBestAvailableProfileEnv().env;
	const projectEnv = loadProjectEnvForSubprocess(project);

	return await new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(pythonCommand, [...pythonBaseArgs, ...args], {
				cwd: sourcePath,
				env: {
					...getIsolatedGitEnv(),
					...pythonEnv,
					...profileEnv,
					...projectEnv,
					GITHUB_CLI_PATH: getToolPath("gh"),
					APP_LANGUAGE: getAppLanguage(),
					PYTHONUNBUFFERED: "1",
					PYTHONUTF8: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			finish(null);
			return;
		}

		const timeoutId = setTimeout(() => {
			killProcessGracefully(child, {
				debugPrefix: "[VISUAL_PROOF_SYNC]",
				debug: false,
			});
			finish(null);
		}, PR_DETECTION_TIMEOUT_MS);

		let stdout = "";
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString("utf-8");
		});
		child.on("error", () => {
			clearTimeout(timeoutId);
			finish(null);
		});
		child.on("close", () => {
			clearTimeout(timeoutId);
			const parsed = parsePRJsonOutput(stdout);
			finish(parsed?.prUrl ?? null);
		});
	});
}

/**
 * Build arguments for the create-pr Python script
 */
export function buildCreatePRArgs(
	runScript: string,
	specId: string,
	projectPath: string,
	options: WorktreeCreatePROptions | undefined,
	taskBaseBranch: string | undefined,
	bodyFilePath?: string,
): { args: string[]; validationError?: string } {
	const args = [
		runScript,
		"--spec",
		specId,
		"--project-dir",
		projectPath,
		"--create-pr",
	];

	// Add optional arguments with validation
	if (options?.targetBranch) {
		// Validate branch name to prevent malformed git commands
		if (!GIT_BRANCH_REGEX.test(options.targetBranch)) {
			return { args: [], validationError: "Invalid target branch name" };
		}
		args.push("--pr-target", options.targetBranch);
	}
	if (options?.title) {
		// Validate title for printable characters and length limit
		if (options.title.length > MAX_PR_TITLE_LENGTH) {
			return {
				args: [],
				validationError: `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters`,
			};
		}
		if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
			return {
				args: [],
				validationError: "PR title contains invalid characters",
			};
		}
		args.push("--pr-title", options.title);
	}
	if (options?.draft) {
		args.push("--pr-draft");
	}
	if (bodyFilePath) {
		args.push("--pr-body-file", bodyFilePath);
	}

	// Add --base-branch if task was created with a specific base branch
	if (taskBaseBranch) {
		args.push("--base-branch", taskBaseBranch);
	}

	return { args };
}

/**
 * Initialize Python environment for PR creation
 * @returns Error message if initialization fails, undefined on success
 */
export async function initializePythonEnvForPR(
	pythonEnvManager: PythonEnvManager,
): Promise<string | undefined> {
	if (pythonEnvManager.isEnvReady()) {
		return undefined;
	}

	const autoBuildSource = getEffectiveSourcePath();
	if (!autoBuildSource) {
		return "Python environment not ready and WorkPilot AI source not found";
	}

	const status = await pythonEnvManager.initialize(autoBuildSource);
	if (!status.ready) {
		return `Python environment not ready: ${status.error || "Unknown error"}`;
	}

	return undefined;
}

/**
 * Generic retry wrapper with exponential backoff
 * @param operation - Async function to execute with retry
 * @param options - Retry configuration options
 * @returns Result of the operation or throws after all retries
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: {
		maxRetries?: number;
		baseDelayMs?: number;
		onRetry?: (attempt: number, error: unknown) => void;
		shouldRetry?: (error: unknown) => boolean;
	} = {},
): Promise<T> {
	const {
		maxRetries: rawMaxRetries = 3,
		baseDelayMs = 100,
		onRetry,
		shouldRetry,
	} = options;

	// Ensure at least one attempt is made (clamp to minimum of 1)
	const maxRetries = Math.max(1, rawMaxRetries);

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const isLastAttempt = attempt === maxRetries;

			// Check if we should retry this error
			if (shouldRetry && !shouldRetry(error)) {
				throw error;
			}

			if (isLastAttempt) {
				throw error;
			}

			// Notify about retry
			onRetry?.(attempt, error);

			// Wait before retry (exponential backoff)
			await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
		}
	}

	// This should never be reached, but TypeScript needs it
	throw new Error("Retry loop exited unexpectedly");
}
