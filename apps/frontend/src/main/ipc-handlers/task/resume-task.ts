import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import { relaunchEventFor } from "../../../shared/state-machines";
import type { IPCResult, Project, Task } from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { projectStore } from "../../project-store";
import { taskStateManager } from "../../task-state-manager";
import { findTaskWorktree } from "../../worktree-paths";
import { clearPauseState, existingSpecDirs } from "./pause-state-utils";
import { findTaskAndProject } from "./shared";

/**
 * Relaunching a task from where it stopped.
 *
 * One path for every relaunch that is not a fresh start: the Reprendre button
 * (TASK_RESUME) and the automatic resume of the tasks the application was
 * running when it was closed. Two copies of "how does a paused task restart"
 * is how one of them loses a variable — the old TASK_RESUME already started
 * `run.py` without the task's TDD mode and mobile targets, and on a task
 * paused during spec creation, `run.py` refused the spec directory outright.
 */

/**
 * Every copy of a task's spec directory: the one the task record names, the
 * main project's, and the worktree's.
 */
// biome-ignore lint/suspicious/noExplicitAny: callers pass loosely typed task/project records
export function getSpecPaths(task: any, project: any) {
	const specsBaseDir = getSpecsDir(project.autoBuildPath);
	const specDir =
		task.specsPath || path.join(project.path, specsBaseDir, task.specId);

	const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
	const worktreePath = findTaskWorktree(project.path, task.specId);
	const worktreeSpecDir = worktreePath
		? path.join(worktreePath, specsBaseDir, task.specId)
		: null;

	return { specDir, mainSpecDir, worktreeSpecDir, specsBaseDir };
}

/**
 * Every spec directory copy of this task — main project and worktree.
 *
 * The running backend reads the pause flag from its *own* copy, which for a
 * worktree build is the one inside the worktree. Writing only the main one
 * is how a pause could be requested and never noticed.
 */
export function allSpecDirs(
	specPaths: ReturnType<typeof getSpecPaths>,
): string[] {
	return existingSpecDirs([
		specPaths.specDir,
		specPaths.mainSpecDir,
		specPaths.worktreeSpecDir,
	]);
}

/** The implementation plans among those directories, the ones that exist. */
function existingPlanPaths(specDirs: string[]): string[] {
	return specDirs
		.map((dir) => path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))
		.filter((file) => existsSync(file));
}

/**
 * The phase a running task is in, as the backend would name it.
 *
 * Recorded on the pause so the resume can say where it will pick up, and so
 * the backend's checkpoint prints the phase the user actually paused rather
 * than guessing from whichever loop noticed the flag first.
 */
export function currentPausePhase(
	task: Task,
	specPaths: ReturnType<typeof getSpecPaths>,
): string {
	switch (task.executionProgress?.phase) {
		case "planning":
			// "planning" covers two different backends: the spec pipeline,
			// which runs before any plan exists, and the planner agent, which
			// writes one. The plan file is what tells them apart.
			return existsSync(
				path.join(specPaths.specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
			)
				? "planning"
				: "spec";
		case "qa_review":
			return "qa_review";
		case "qa_fixing":
			return "qa_fixing";
		default:
			return task.status === "ai_review" ? "qa_review" : "coding";
	}
}

/**
 * Convert TaskMetadata to SpecCreationMetadata for spec creation
 * This handles the type incompatibility between the two metadata types
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
export function convertTaskMetadataToSpecCreation(metadata?: any): any {
	if (!metadata) return undefined;

	// The spec pipeline runs the task's spec phase. A locked task always names
	// it; a legacy one fell back on planning, which wrote the spec's phase key
	// for it in the per-phase dropdowns.
	return {
		requireReviewBeforeCoding: metadata.requireReviewBeforeCoding,
		provider: metadata.engineLocked
			? metadata.phaseProviders?.spec || metadata.provider
			: metadata.phaseProviders?.planning ||
				metadata.phaseProviders?.spec ||
				metadata.provider,
		engineLocked: metadata.engineLocked,
		isAutoProfile: metadata.isAutoProfile,
		phaseModels: convertPhaseModelConfig(metadata.phaseModels),
		phaseThinking: convertPhaseThinkingConfig(metadata.phaseThinking),
		model: metadata.model,
		thinkingLevel: metadata.thinkingLevel,
		useWorktree: metadata.useWorktree,
		useLocalBranch: metadata.useLocalBranch,
		tddMode: metadata.tddMode,
		verifyLoop: metadata.verifyLoop,
		mobileTargets: metadata.mobileTargets,
	};
}

/**
 * Convert PhaseModelConfig (string-based) to SpecCreationMetadata format (literal union)
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
function convertPhaseModelConfig(phaseModels?: any): any {
	if (!phaseModels) return undefined;

	return {
		spec: phaseModels.spec || "sonnet",
		planning: phaseModels.planning || "sonnet",
		coding: phaseModels.coding || "sonnet",
		qa: phaseModels.qa || "sonnet",
	};
}

/**
 * Convert PhaseThinkingConfig to SpecCreationMetadata format
 */
// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
function convertPhaseThinkingConfig(phaseThinking?: any): any {
	if (!phaseThinking) return undefined;

	return {
		spec: phaseThinking.spec || "medium",
		planning: phaseThinking.planning || "medium",
		coding: phaseThinking.coding || "medium",
		qa: phaseThinking.qa || "medium",
	};
}

/**
 * The SDK session id the backend persisted for this task, if any.
 *
 * `<specDir>/.session.json` is written by the Python side as soon as a session
 * has an id (and again when it ends), and handing it back as
 * AUTO_CLAUDE_RESUME_SESSION_ID makes the SDK rehydrate that transcript
 * instead of starting cold. Best-effort by design: a task that has never run,
 * a truncated file or a missing field all mean "start fresh", which is what a
 * resume did before this existed — never a reason to refuse the resume itself.
 *
 * Only a Claude session id is handed back. Codex records its thread id in the
 * same file, and the Claude SDK asked to rehydrate a thread it never wrote
 * fails the session; every other provider gets its context from the
 * conversation log, which the backend replays on its own. A marker written
 * before the provider was recorded is taken to be Claude's — the only one that
 * wrote it then.
 */
export function readPersistedSessionId(specDir: string): string | undefined {
	const sessionFile = path.join(specDir, ".session.json");
	if (!existsSync(sessionFile)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(sessionFile, "utf-8")) as {
			session_id?: string;
			provider?: string | null;
		};
		const provider = parsed.provider ?? "claude";
		if (provider !== "claude" && provider !== "anthropic") return undefined;
		return parsed.session_id || undefined;
	} catch (err) {
		appLog.warn(`[readPersistedSessionId] Could not read ${sessionFile}:`, err);
		return undefined;
	}
}

/**
 * Leave the failure state, and let the next run's events through.
 *
 * Two halves, both owed by every relaunch that is not TASK_START. The event
 * (see `relaunchEventFor`) is what clears the review reason and the
 * `errorMessage` the failure banner renders. Resetting the sequence counter is
 * the other: every restarted backend numbers its events from zero, and
 * `isNewSequence` drops anything below the last number it saw — so without it
 * the resumed run's phases reached nobody and the panel stayed frozen on the
 * state it had failed in.
 */
export function leaveFailureStateForRelaunch(
	taskId: string,
	task: Task,
	project: Project,
): void {
	const event = relaunchEventFor(taskStateManager.getCurrentState(taskId), task);
	if (event) {
		taskStateManager.handleUiEvent(taskId, event, task, project);
	}
	taskStateManager.resetForNewRun(taskId);
}

/**
 * Resume a paused task from where it stopped.
 *
 * Clearing the flag is all the phase routing this needs: the backend re-enters
 * the pipeline and reads what is on disk — no plan means planning runs again,
 * an incomplete plan means coding resumes at the first unfinished subtask
 * (the one the interrupted session was on, reopened by the coder), a complete
 * one means QA. Naming a phase here would be a second opinion about a question
 * the spec directory already answers.
 *
 * The one thing the spec directory cannot answer on its own is "is there a
 * spec at all": `run.py` refuses a directory without `spec.md`, so a task
 * stopped during spec creation goes back to the spec pipeline, which skips
 * every artefact it already produced.
 */
export async function resumePausedTask(
	agentManager: AgentManager,
	taskId: string,
	projectId?: string,
	options: {
		/**
		 * Hand the persisted Claude session back to the SDK. False when the
		 * resumed phase changed engine away from Claude: that transcript belongs
		 * to another model, and the conversation log carries the context.
		 */
		keepSession?: boolean;
	} = {},
): Promise<
	IPCResult<{
		taskId: string;
		resumed: boolean;
		resumedPhase: string | null;
	}>
> {
	const { task, project } = findTaskAndProject(taskId, projectId);
	if (!task || !project) {
		return { success: false, error: "Task not found" };
	}

	const specPaths = getSpecPaths(task, project);
	const specDirs = allSpecDirs(specPaths);
	if (specDirs.length === 0) {
		return { success: false, error: "Spec directory not found" };
	}

	const pausedPhase = task.metadata?.paused?.paused_phase ?? null;
	clearPauseState(specDirs, existingPlanPaths(specDirs), {
		provider: task.metadata?.provider ?? null,
		model: task.metadata?.model ?? null,
	});

	projectStore.invalidateTasksCache(project.id);

	// A resume is a relaunch: drop the previous run's failure and let the new
	// run's events through. See leaveFailureStateForRelaunch.
	leaveFailureStateForRelaunch(taskId, task, project);

	const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;
	const mainSpecDir = specPaths.mainSpecDir;
	fileWatcher.watch(taskId, mainSpecDir);

	if (!existsSync(path.join(mainSpecDir, AUTO_BUILD_PATHS.SPEC_FILE))) {
		await agentManager.startSpecCreation(
			taskId,
			project.path,
			task.description || task.title,
			mainSpecDir,
			convertTaskMetadataToSpecCreation(task.metadata),
			baseBranch,
			project.id,
		);
	} else {
		await agentManager.startTaskExecution(
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
				// Pick the transcript back up rather than re-deriving it. The
				// phase the pause interrupted is re-entered from the spec
				// directory either way — what this adds is the reasoning of the
				// session that was interrupted, so the resume continues the
				// analysis instead of paying for it twice. Single-shot on the
				// backend (create_client pops the variable), and dropped there
				// when the SDK has no transcript for it, in which case the
				// conversation log carries the context like for every other
				// provider.
				resumeSessionId:
					options.keepSession === false
						? undefined
						: readPersistedSessionId(specPaths.specDir),
			},
			project.id,
		);
	}

	appLog.info(
		`[resume-task] Task ${taskId} resumed (stopped during ${pausedPhase ?? "unknown phase"})`,
	);

	return {
		success: true,
		data: { taskId, resumed: true, resumedPhase: pausedPhase },
	};
}
