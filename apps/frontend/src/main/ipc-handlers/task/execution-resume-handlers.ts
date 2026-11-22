
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import {
	type EngineChangeScope,
} from "../../../shared/utils/task-engine";
import type { IPCResult, Project, Task } from "../../../shared/types";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { projectStore } from "../../project-store";
import { findTaskWorktree } from "../../worktree-paths";
import { persistPlanStatus } from "./plan-file-utils";
import { clearPauseState } from "./pause-state-utils";
import { resumeTaskWithProvider } from "./resume-with-provider";
import { findTaskAndProject } from "./shared";
import {
	allSpecDirs,
	convertTaskMetadataToSpecCreation,
	getSpecPaths,
} from "./resume-task";
import {
	buildPhaseRerunPlanUpdate,
	downstreamLogPhases,
	startPhaseRerun,
	type RerunPhase,
} from "./plan-rerun-utils";
import {
	type ExecutionHandlerContext,
	atomicWriteFileSync,
	getPlanPaths,
	safeReadFileSync,
} from "./execution-utils";

export function registerTaskResumeHandlers(ctx: ExecutionHandlerContext): void {
	const { agentManager, getMainWindow } = ctx;

	/**
	 * Resume a paused task (rate limited or auth failure paused).
	 *
	 * Writes a RESUME file to signal the existing subprocess to continue. The
	 * default provider in Settings is not consulted: the task owns its engine,
	 * and changing it is TASK_RESUME_WITH_PROVIDER's job, asked on the task.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_PAUSED,
		async (_, taskId: string): Promise<IPCResult> => {
			// Find task and project
			const { task, project } = findTaskAndProject(taskId);

			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			// Get the spec directory - use task.specsPath if available (handles worktree vs main)
			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir =
				task.specsPath || path.join(project.path, specsBaseDir, task.specId);

			return await writeResumeFile(task, project, specDir, specsBaseDir);
		},
	);

	/** Resume a paused task on another engine: see resumeTaskWithProvider. */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESUME_WITH_PROVIDER,
		async (
			_,
			taskId: string,
			providerName: string,
			model?: string,
			effort?: string,
			scope?: EngineChangeScope,
		): Promise<IPCResult> => {
			return await resumeTaskWithProvider(agentManager, taskId, providerName, {
				model,
				effort,
				scope,
			});
		},
	);

	/**
	 * Re-run one execution phase on demand (planning / coding / validation).
	 *
	 * Phase entry is state-driven by implementation_plan.json (see
	 * plan-rerun-utils.ts), so a re-run rewinds the plan to before the target
	 * phase and restarts the task — the backend then re-enters at that phase.
	 * Re-running an earlier phase cascade-invalidates the later ones (planning ⊃
	 * coding ⊃ validation): their plan state AND their logs are cleared so the
	 * feed reflects the fresh run. The worktree is recreated automatically by
	 * startTaskExecution if it was cleaned up.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RERUN_PHASE,
		async (_, taskId: string, phase: RerunPhase): Promise<IPCResult> => {
			const VALID_PHASES: RerunPhase[] = ["planning", "coding", "validation"];
			if (!VALID_PHASES.includes(phase)) {
				return { success: false, error: `Invalid phase: ${phase}` };
			}

			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			try {
				// 1. Stop any running subprocess FIRST so it can't overwrite the plan
				//    reset we are about to write. Wait briefly for cleanup.
				agentManager.killTask(taskId);
				fileWatcher.unwatch(taskId);
				await new Promise<void>((resolve) => setTimeout(resolve, 500));

				const specPaths = getSpecPaths(task, project);
				const specDirs = allSpecDirs(specPaths);

				// 2. Rewind the plan (every copy) to before `phase`.
				const planPaths = getPlanPaths(specPaths, project);
				let planWritten = false;
				for (const planFile of planPaths.all) {
					const content = safeReadFileSync(planFile);
					if (!content) continue;
					let plan: Record<string, unknown>;
					try {
						plan = JSON.parse(content);
					} catch {
						continue;
					}
					buildPhaseRerunPlanUpdate(plan, phase);
					atomicWriteFileSync(planFile, JSON.stringify(plan, null, 2));
					planWritten = true;
				}
				if (!planWritten && phase !== "planning") {
					return {
						success: false,
						error:
							"No implementation plan found to re-run. Start the task first.",
					};
				}

				// 3. Clear the target + downstream phases' logs (shared feed AND the
				//    per-LLM mirror files) so the view doesn't show stale entries.
				const phasesToClear = downstreamLogPhases(phase);
				for (const dir of specDirs) {
					clearPhaseLogsInDir(dir, phasesToClear);
				}

				// 4. Delete runtime halt / pause markers that would otherwise block
				//    or immediately re-park the restarted task.
				const markerNames = [
					"PROMPT_TOO_LONG_HALT",
					"LOCAL_MODEL_NO_TOOLS_HALT",
					"PAUSE",
					"RESUME_WITH_PROVIDER",
					"HOT_SWAP.json",
				];
				for (const dir of specDirs) {
					for (const name of markerNames) {
						try {
							unlinkSync(path.join(dir, name));
						} catch {
							// missing marker is the normal case
						}
					}
				}

				// The cooperative pause lives in pause_state.json, not in the plan,
				// so rewinding the plan does not lift it. Left set, the restarted
				// build stops again at its first checkpoint and the re-run looks
				// like it did nothing.
				clearPauseState(specDirs, planPaths.all, {
					provider: task.metadata?.provider ?? null,
					model: task.metadata?.model ?? null,
				});

				projectStore.invalidateTasksCache(project.id);
				if (task.metadata?.paused) task.metadata.paused.enabled = false;

				// 5. Restart from the reset phase. startTaskExecution recreates the
				//    worktree if it was cleaned up.
				const baseBranch =
					task.metadata?.baseBranch || project.settings?.mainBranch;
				const specDir = specPaths.specDir;
				await startPhaseRerun(phase, {
					spec: async () => {
						fileWatcher.watch(taskId, specDir);
						await agentManager.startSpecCreation(
							taskId,
							project.path,
							task.description || task.title,
							specDir,
							convertTaskMetadataToSpecCreation(task.metadata),
							baseBranch,
							project.id,
						);
					},
					execution: async () => {
						await agentManager.startTaskExecution(
							taskId,
							project.path,
							task.specId,
							{
								useWorktree: task.metadata?.useWorktree !== false,
								baseBranch,
							},
							project.id,
						);
					},
					isRunning: () => agentManager.isRunning(taskId),
				});

				appLog.info(
					`[TASK_RERUN_PHASE] task=${taskId} phase=${phase} ` +
						`cleared=[${phasesToClear.join(",")}] dirs=${specDirs.length}`,
				);
				return { success: true };
			} catch (err) {
				fileWatcher.unwatch(taskId);
				const failedSpecs = getSpecPaths(task, project);
				const failedPaths = getPlanPaths(failedSpecs, project);
				for (const planFile of failedPaths.all) {
					// The history is the main project's copy's alone.
					const main = path.dirname(planFile) === failedSpecs.mainSpecDir;
					await persistPlanStatus(
						planFile,
						"human_review",
						project.id,
						main ? "system" : undefined,
					);
				}
				getMainWindow()?.webContents.send(
					IPC_CHANNELS.TASK_STATUS_CHANGE,
					taskId,
					"human_review",
					project.id,
				);
				appLog.error(
					`[TASK_RERUN_PHASE] Failed for task ${taskId} phase ${phase}:`,
					err,
				);
				return {
					success: false,
					error: err instanceof Error ? err.message : "Failed to re-run phase",
				};
			}
		},
	);

	/**
	 * Live LLM hot-swap: change provider/model/effort for one phase WHILE the task
	 * is running. Writes a single-shot HOT_SWAP.json marker in the spec dir(s); the
	 * running agent applies it at the next safe boundary (next sub-task/QA pass, or
	 * — for the single-session planner — by ending the current session early) and
	 * replays the conversation log so the new model keeps the accumulated context.
	 * The dropdown change is ALSO persisted to task_metadata.json by the caller, so
	 * even if the marker is missed the next session picks the change up.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_HOT_SWAP,
		async (
			_,
			taskId: string,
			configPhase: "spec" | "planning" | "coding" | "qa",
			change: { provider?: string; model?: string; effort?: string },
		): Promise<IPCResult> => {
			const VALID_PHASES = ["spec", "planning", "coding", "qa"];
			if (!VALID_PHASES.includes(configPhase)) {
				return { success: false, error: `Invalid phase: ${configPhase}` };
			}
			if (!change || (!change.provider && !change.model && !change.effort)) {
				return { success: false, error: "No change provided" };
			}
			// Each field reaches the running agent as written: text or nothing.
			for (const value of [change.provider, change.model, change.effort]) {
				if (value !== undefined && value !== null && typeof value !== "string") {
					return { success: false, error: "Invalid change" };
				}
			}
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			try {
				const specPaths = getSpecPaths(task, project);
				const specDirs = [
					specPaths.specDir,
					specPaths.mainSpecDir,
					specPaths.worktreeSpecDir,
				].filter(
					(d, i, arr): d is string =>
						!!d && existsSync(d) && arr.indexOf(d) === i,
				);
				const payload = JSON.stringify({
					phase: configPhase,
					provider: change.provider ?? null,
					model: change.model ?? null,
					effort: change.effort ?? null,
					requested_at: new Date().toISOString(),
				});
				let wrote = false;
				for (const dir of specDirs) {
					try {
						atomicWriteFileSync(path.join(dir, "HOT_SWAP.json"), payload);
						wrote = true;
					} catch (err) {
						appLog.warn(
							`[TASK_HOT_SWAP] Could not write marker in ${dir}:`,
							err,
						);
					}
				}
				if (!wrote) {
					return { success: false, error: "Could not write hot-swap marker" };
				}
				appLog.info(
					`[TASK_HOT_SWAP] task=${taskId} phase=${configPhase} ` +
						`provider=${change.provider ?? "-"} model=${change.model ?? "-"} ` +
						`effort=${change.effort ?? "-"} dirs=${specDirs.length}`,
				);
				return { success: true };
			} catch (err) {
				appLog.error(`[TASK_HOT_SWAP] Failed for task ${taskId}:`, err);
				return {
					success: false,
					error: err instanceof Error ? err.message : "Hot-swap failed",
				};
			}
		},
	);

	/**
	 * Reset the target + downstream phase entries in every task_logs*.json file
	 * (the shared feed and each per-LLM mirror) within one spec dir. Best-effort:
	 * a re-run must never fail because a log file is missing or malformed.
	 */
	function clearPhaseLogsInDir(dir: string, phaseKeys: string[]): void {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name !== "task_logs.json" && !/^task_logs\..+\.json$/.test(name)) {
				continue;
			}
			const filePath = path.join(dir, name);
			try {
				const raw = safeReadFileSync(filePath);
				if (!raw) continue;
				const data = JSON.parse(raw) as {
					phases?: Record<string, Record<string, unknown>>;
				};
				if (!data.phases) continue;
				let changed = false;
				for (const key of phaseKeys) {
					if (data.phases[key]) {
						data.phases[key] = {
							phase: data.phases[key].phase ?? key,
							status: "pending",
							started_at: null,
							completed_at: null,
							entries: [],
						};
						changed = true;
					}
				}
				if (changed) {
					atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
				}
			} catch {
				// Skip unreadable/malformed log files.
			}
		}
	}

	/**
	 * Reset the persisted conversation log for a task.
	 *
	 * Use case: the LLM returned a "prompt too long" error (HTTP 400) and
	 * the task is parked in human_review with reviewReason="prompt_too_long".
	 * Retrying with the same conversation log will fail identically, so the
	 * user explicitly wipes the transcript and the halt marker, then restarts
	 * the task with a fresh context.
	 *
	 * Removed:
	 *   - {spec_dir}/conversation.jsonl  (the replay log)
	 *   - {spec_dir}/PROMPT_TOO_LONG_HALT (the backend halt marker)
	 *
	 * The user's plan, subtasks, code, etc. are left untouched.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_RESET_CONVERSATION,
		async (_, taskId: string): Promise<IPCResult> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}

			const specsBaseDir = getSpecsDir(project.autoBuildPath);
			const specDir =
				task.specsPath || path.join(project.path, specsBaseDir, task.specId);

			try {
				const conversationLog = path.join(specDir, "conversation.jsonl");
				const haltMarker = path.join(specDir, "PROMPT_TOO_LONG_HALT");
				const localNoToolsMarker = path.join(
					specDir,
					"LOCAL_MODEL_NO_TOOLS_HALT",
				);
				let removed = 0;
				for (const target of [
					conversationLog,
					haltMarker,
					localNoToolsMarker,
				]) {
					if (existsSync(target)) {
						unlinkSync(target);
						removed++;
					}
				}
				// Per-model conversation logs (conversation.<model>.jsonl) + the
				// .migrated marker — the model is in the filename, so glob them.
				if (existsSync(specDir)) {
					for (const name of readdirSync(specDir)) {
						if (
							/^conversation\..+\.jsonl$/.test(name) ||
							name === "conversation.jsonl.migrated"
						) {
							try {
								unlinkSync(path.join(specDir, name));
								removed++;
							} catch {
								/* best-effort */
							}
						}
					}
				}
				appLog.info(
					`[TASK_RESET_CONVERSATION] task=${taskId} removed=${removed} files in ${specDir}`,
				);
				return { success: true };
			} catch (err) {
				appLog.error(
					`[TASK_RESET_CONVERSATION] failed for task ${taskId}:`,
					err,
				);
				return {
					success: false,
					error:
						err instanceof Error
							? err.message
							: "Failed to reset conversation log",
				};
			}
		},
	);

	/**
	 * Handle writing RESUME file to worktree if it exists
	 */
	async function handleWorktreeResumeFile(
		task: Task,
		project: Project,
		specsBaseDir: string,
		resumeContent: string,
	): Promise<void> {
		const worktreePath = findTaskWorktree(project.path, task.specId);
		if (worktreePath) {
			const worktreeResumeFilePath = path.join(
				worktreePath,
				specsBaseDir,
				task.specId,
				"RESUME",
			);
			try {
				atomicWriteFileSync(worktreeResumeFilePath, resumeContent);
				appLog.info(
					`[TASK_RESUME_PAUSED] Also wrote RESUME file to worktree: ${worktreeResumeFilePath}`,
				);
			} catch (worktreeError) {
				// Non-fatal - main spec dir RESUME is sufficient
				console.warn(
					`[TASK_RESUME_PAUSED] Could not write to worktree (non-fatal):`,
					worktreeError,
				);
			}
		} else if (
			task.executionProgress?.phase === "rate_limit_paused" ||
			task.executionProgress?.phase === "auth_failure_paused"
		) {
			// Warn if worktree not found for a paused task - the backend is likely
			// running inside the worktree and may not see the RESUME file in the main spec dir
			console.warn(
				`[TASK_RESUME_PAUSED] Worktree not found for paused task ${task.specId}. ` +
					`Backend may not detect the RESUME file if running inside a worktree.`,
			);
		}
	}

	/**
	 * Write RESUME file to signal existing subprocess to continue
	 */
	async function writeResumeFile(
		task: Task,
		project: Project,
		specDir: string,
		specsBaseDir: string,
	): Promise<IPCResult> {
		const resumeFilePath = path.join(specDir, "RESUME");

		try {
			const resumeContent = JSON.stringify({
				resumed_at: new Date().toISOString(),
				resumed_by: "user",
			});
			atomicWriteFileSync(resumeFilePath, resumeContent);
			appLog.info(
				`[TASK_RESUME_PAUSED] Wrote RESUME file to: ${resumeFilePath}`,
			);

			// Also write to worktree if it exists (backend may be running inside the worktree)
			await handleWorktreeResumeFile(
				task,
				project,
				specsBaseDir,
				resumeContent,
			);

			return { success: true };
		} catch (error) {
			appLog.error("[TASK_RESUME_PAUSED] Failed to write RESUME file:", error);
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Failed to signal resume",
			};
		}
	}
}
