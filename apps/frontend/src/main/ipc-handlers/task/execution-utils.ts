
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { type BrowserWindow } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import { isAnthropicNativeVersionedModelId } from "../../../shared/constants/models";
import {
	buildEngineMetadata,
	ENGINE_PHASES,
	type EngineSeedSettings,
	engineUsesClaude,
	isClaudeProvider,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { taskEngineFromMetadata } from "../../agent/task-provider-env";
import type { TaskEvent } from "../../../shared/state-machines/task-machine";
import type {
	Project,
	Task,
	TaskStatus,
} from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { learningLoopService } from "../../learning-loop-service";
import {
	type ClaudeProfileManager,
	initializeClaudeProfileManager,
} from "../../claude-profile-manager";
import { fileWatcher } from "../../file-watcher";
import { checkGitStatus } from "../../project-initializer";
import { readSettingsFile } from "../../settings-utils";
import { taskStateManager } from "../../task-state-manager";
import { findTaskAndProject } from "./shared";
import { allSpecDirs, getSpecPaths } from "./resume-task";

/**
 * What the handler groups share: the agent manager and the main window.
 */
export interface ExecutionHandlerContext {
	agentManager: AgentManager;
	getMainWindow: () => BrowserWindow | null;
}

/**
 * Whether starting `task` needs Claude OAuth authentication.
 *
 * A Kanban task answers from its own engine (shared/utils/task-engine.ts):
 * Claude is required as soon as one of its phases runs on Claude. Without a
 * task, the default provider from Settings decides. Non-Claude providers
 * (Windsurf, OpenAI, Google, etc.) handle their own auth.
 */
export function requiresClaudeAuth(task?: Task, project?: Project): boolean {
	if (task?.metadata) {
		return engineUsesClaude(
			taskEngineFromMetadata(
				task.metadata,
				undefined,
				project?.settings?.provider,
			),
		);
	}
	const settings = readSettingsFile();
	const selectedProvider = (
		settings?.selectedProvider as string | undefined
	)?.toLowerCase();
	return (
		!selectedProvider ||
		selectedProvider === "claude" ||
		selectedProvider === "anthropic"
	);
}

/**
 * Feed the learning loop with a human review verdict, inferred from a kanban
 * status transition. Fire-and-forget — never blocks the status change.
 *
 * - Approved: a reviewed task moves forward to done/pr_created.
 * - Rejected: a task in human_review is sent back to an earlier column
 *   (the reviewer wants rework).
 */
export function recordReviewVerdictForLearning(
	previousStatus: TaskStatus,
	newStatus: TaskStatus,
	project: Project,
	task: Task,
): void {
	try {
		const movingForwardToDone =
			(newStatus === "done" || newStatus === "pr_created") &&
			(previousStatus === "human_review" || previousStatus === "ai_review");

		const sentBackFromReview =
			previousStatus === "human_review" &&
			(newStatus === "backlog" ||
				newStatus === "queue" ||
				newStatus === "in_progress");

		if (movingForwardToDone) {
			learningLoopService.recordTaskOutcome(
				project.path,
				task.specId,
				"approved",
			);
		} else if (sentBackFromReview) {
			learningLoopService.recordTaskOutcome(
				project.path,
				task.specId,
				"rejected",
				"Human reviewer sent the task back for rework.",
			);
		}
	} catch (err) {
		console.warn(
			"[TASK_UPDATE_STATUS] Learning outcome recording failed:",
			err,
		);
	}
}

/**
 * Make sure `task` owns its engine before it runs.
 *
 * This used to be `syncTaskProvider`, which replaced the task's provider —
 * and its phase models — with the project's or the header's on every start,
 * QA run and resume: a task created for Ollama ran on whatever the header
 * said that morning. A task now owns its engine (`engineLocked`), and nothing
 * here touches one that does.
 *
 * A task written before that rule is migrated once: each phase keeps what the
 * task named (`phaseProviders`, then `provider`), the rest comes from the
 * Settings presets of that provider, and the result is written locked into
 * every copy of task_metadata.json. A dash-versioned Anthropic model left on a
 * phase that now runs elsewhere is replaced by that provider's preset, as the
 * old sync did.
 *
 * @returns true when the task was migrated.
 */
export function ensureTaskEngine(task: Task, project: Project, specDir: string): boolean {
	if (!task.metadata || task.metadata.engineLocked) return false;

	const settings = readSettingsFile() as EngineSeedSettings | undefined;
	const engine = taskEngineFromMetadata(
		task.metadata,
		settings,
		project.settings?.provider,
	);
	for (const phase of ENGINE_PHASES) {
		const trio = engine[phase];
		if (
			!isClaudeProvider(trio.provider) &&
			isAnthropicNativeVersionedModelId(trio.model)
		) {
			trio.model = seedEngine(settings, trio.provider)[phase].model;
		}
	}
	const update = buildEngineMetadata(engine);
	Object.assign(task.metadata, update);

	const dirs = new Set([specDir, ...allSpecDirs(getSpecPaths(task, project))]);
	for (const dir of dirs) {
		try {
			const metadataPath = path.join(dir, "task_metadata.json");
			if (!existsSync(metadataPath)) continue;
			const content = safeReadFileSync(metadataPath);
			if (!content) continue;
			atomicWriteFileSync(
				metadataPath,
				JSON.stringify({ ...JSON.parse(content), ...update }, null, 2),
			);
		} catch (err) {
			console.warn(`[TaskEngine] Failed to migrate ${dir}:`, err);
		}
	}
	console.warn(
		`[TaskEngine] Task ${task.id} now owns its engine:`,
		ENGINE_PHASES.map((phase) => `${phase}=${engine[phase].provider}`).join(
			" ",
		),
	);
	return true;
}

/**
 * Atomic file write to prevent TOCTOU race conditions.
 * Writes to a temporary file first, then atomically renames to target.
 * This ensures the target file is never in an inconsistent state.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
	const tempPath = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, content, "utf-8");
		renameSync(tempPath, filePath);
	} catch (error) {
		// Clean up the temp file if rename failed
		try {
			unlinkSync(tempPath);
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if a file doesn't exist or can't be read.
 */
export function safeReadFileSync(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		// ENOENT (file not found) is expected, other errors should be logged
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			appLog.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
		}
		return null;
	}
}

/**
 * Helper function to check subtask completion status
 */
export function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
	allSubtasks: Array<{ status: string }>;
	completedCount: number;
	totalCount: number;
	allCompleted: boolean;
} {
	const allSubtasks =
		(
			plan?.phases as
				| Array<{ subtasks?: Array<{ status: string }> }>
				| undefined
		)?.flatMap((phase) => phase.subtasks || []) || [];
	const completedCount = allSubtasks.filter(
		(s) => s.status === "completed",
	).length;
	const totalCount = allSubtasks.length;
	const allCompleted = totalCount > 0 && completedCount === totalCount;

	return { allSubtasks, completedCount, totalCount, allCompleted };
}

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 *
 * @returns Success with profile manager, or failure with error message
 */
export async function ensureProfileManagerInitialized(): Promise<
	| { success: true; profileManager: ClaudeProfileManager }
	| { success: false; error: string }
> {
	try {
		const profileManager = await initializeClaudeProfileManager();
		return { success: true, profileManager };
	} catch (error) {
		appLog.error(
			"[ensureProfileManagerInitialized] Failed to initialize:",
			error,
		);
		// Include actual error details for debugging while providing actionable guidance
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`,
		};
	}
}

/**
 * Determine the appropriate start event based on current state
 */
export function determineStartEvent(
	taskId: string,
	task: Task,
): { type: TaskEvent["type"]; resetTask?: Task } {
	const currentXState = taskStateManager.getCurrentState(taskId);

	if (currentXState === "done") {
		taskStateManager.clearTask(taskId);
		const resetTask = {
			...task,
			status: "backlog" as TaskStatus,
			reviewReason: undefined,
			executionProgress: undefined,
		};
		return { type: "PLANNING_STARTED", resetTask };
	}

	if (currentXState === "plan_review") {
		return { type: "PLAN_APPROVED" };
	}

	if (currentXState === "human_review" || currentXState === "error") {
		// Une tache en echec pendant la planification n'a pas de plan/sous-taches :
		// il faut relancer la planification, pas sauter au codage. Sinon XState
		// reste sur un etat incoherent et le garde "settled-state" peut bloquer la
		// progression cote frontend.
		if (currentXState === "error" && (task.subtasks?.length ?? 0) === 0) {
			return { type: "PLANNING_STARTED" };
		}
		return { type: "USER_RESUMED" };
	}

	if (currentXState === "backlog") {
		return { type: "PLANNING_STARTED" };
	}

	if (currentXState) {
		taskStateManager.clearTask(taskId);
		const resetTask = {
			...task,
			status: "backlog" as TaskStatus,
			reviewReason: undefined,
			executionProgress: undefined,
		};
		return { type: "PLANNING_STARTED", resetTask };
	}

	// No XState actor - fallback to task data
	if (task.status === "human_review" && task.reviewReason === "plan_review") {
		return { type: "PLAN_APPROVED" };
	}

	if (
		task.status === "human_review" ||
		task.status === "error" ||
		task.status === "build_failed"
	) {
		if (task.status === "error" && (task.subtasks?.length ?? 0) === 0) {
			return { type: "PLANNING_STARTED" };
		}
		return { type: "USER_RESUMED" };
	}

	// Fresh start
	return { type: "PLANNING_STARTED" };
}

/**
 * Validate prerequisites for task execution
 */
export async function validateTaskPrerequisites(
	taskId: string,
	_mainWindow: BrowserWindow,
): Promise<
	| {
			success: true;
			profileManager: ClaudeProfileManager;
			task: Task;
			project: Project;
	  }
	| { success: false; error: string }
> {
	// Ensure profile manager is initialized before checking auth
	const initResult = await ensureProfileManagerInitialized();
	if (!initResult.success) {
		return { success: false, error: initResult.error };
	}

	// Find task and project
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) {
		return { success: false, error: "Task or project not found" };
	}

	// Check git status
	const gitStatus = checkGitStatus(project.path);
	if (!gitStatus.isGitRepo) {
		return {
			success: false,
			error:
				'Git repository required. Please run "git init" in your project directory. WorkPilot AI uses git worktrees for isolated builds.',
		};
	}
	if (!gitStatus.hasCommits) {
		return {
			success: false,
			error:
				'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
		};
	}

	// Check authentication for Claude
	if (requiresClaudeAuth(task, project) && !initResult.profileManager.hasValidAuth()) {
		return {
			success: false,
			error:
				"Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.",
		};
	}

	return {
		success: true,
		profileManager: initResult.profileManager,
		task,
		project,
	};
}

/**
 * Setup task execution environment
 */
export function setupTaskExecution(
	taskId: string,
	task: Task,
	project: Project,
): {
	specDir: string;
	hasSpec: boolean;
	needsSpecCreation: boolean;
	needsImplementation: boolean;
} {
	const specsBaseDir = getSpecsDir(project.autoBuildPath);
	const specDir = path.join(project.path, specsBaseDir, task.specId);

	// Start file watcher
	fileWatcher.watch(taskId, specDir);

	// Check if spec.md exists
	const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
	const hasSpec = existsSync(specFilePath);
	const needsSpecCreation = !hasSpec;
	const needsImplementation = hasSpec && task.subtasks.length === 0;

	return { specDir, hasSpec, needsSpecCreation, needsImplementation };
}

/**
 * Get all plan file paths that need updating
 */
export function getPlanPaths(
	specPaths: ReturnType<typeof getSpecPaths>,
	_project: Project,
): { primary: string; all: string[] } {
	const planPath = path.join(
		specPaths.specDir,
		AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
	);
	const planPathsToUpdate: string[] = [planPath];

	if (
		specPaths.mainSpecDir !== specPaths.specDir &&
		existsSync(
			path.join(specPaths.mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
		)
	) {
		planPathsToUpdate.push(
			path.join(specPaths.mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
		);
	}

	if (
		specPaths.worktreeSpecDir &&
		specPaths.worktreeSpecDir !== specPaths.specDir &&
		existsSync(
			path.join(
				specPaths.worktreeSpecDir,
				AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
			),
		)
	) {
		planPathsToUpdate.push(
			path.join(
				specPaths.worktreeSpecDir,
				AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
			),
		);
	}

	appLog.info(
		`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`,
		planPathsToUpdate,
	);

	return { primary: planPath, all: planPathsToUpdate };
}
