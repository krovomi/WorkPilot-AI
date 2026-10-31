
import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";

// ESM doesn't expose import.meta.dirname out of the box. The main process is bundled
// as ESM (apps/frontend/package.json sets "type": "module"), so we have to
// derive the directory of this module from import.meta.url ourselves.
import { getSpecsDir, IPC_CHANNELS } from "../../../shared/constants";
import {
	applyEngineChange,
	buildEngineMetadata,
	ENGINE_PHASES,
	type EngineChangeScope,
	type EngineSeedSettings,
	enginePhaseForPause,
	isClaudeProvider,
	sameTrio,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { taskEngineFromMetadata } from "../../agent/task-provider-env";
import type { IPCResult, Project, Task } from "../../../shared/types";
import type { ThinkingLevel } from "../../../shared/types/settings";
import { appLog } from "../../app-logger";
import { fileWatcher } from "../../file-watcher";
import { projectStore } from "../../project-store";
import { readSettingsFile } from "../../settings-utils";
import { findTaskWorktree } from "../../worktree-paths";
import { persistPlanStatus } from "./plan-file-utils";
import { clearPauseState } from "./pause-state-utils";
import { findTaskAndProject } from "./shared";
import {
	allSpecDirs,
	convertTaskMetadataToSpecCreation,
	currentPausePhase,
	getSpecPaths,
	resumePausedTask,
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

	/**
	 * Resume a paused task on another engine (Fournisseur × LLM × Effort).
	 *
	 * The trio applies to the phase the task was paused in and, with
	 * `scope: "remaining"` (the default), to every phase after it; `"phase"`
	 * limits it to the resumed phase. Phases already behind the task keep what
	 * they ran on. The result is written into every copy of task_metadata.json
	 * with `engineLocked`, which is what the backend reads — no marker, no
	 * single-shot override that a second session would lose.
	 *
	 * The relaunch then goes through `resumePausedTask`, the Reprendre button's
	 * own path, so TDD mode, mobile targets, the worktree and the return to the
	 * spec pipeline for a task paused before its spec exists are all kept. The
	 * Claude SDK session is rehydrated only when the resumed phase stays on
	 * Claude; any other switch carries its context through the conversation
	 * log, which the backend hands to the new model of the same phase.
	 */
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
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			if (!providerName || typeof providerName !== "string") {
				return {
					success: false,
					error: "Missing or invalid providerName argument",
				};
			}

			const provider = providerName.trim();
			const chosenModel = model?.trim() || undefined;
			// Validate the effort against the known thinking levels; ignore garbage
			// so a malformed value never poisons task_metadata.json.
			const VALID_EFFORTS = ["none", "low", "medium", "high", "ultrathink"];
			const chosenEffort =
				effort && VALID_EFFORTS.includes(effort.trim())
					? (effort.trim() as ThinkingLevel)
					: undefined;
			const changeScope: EngineChangeScope =
				scope === "phase" ? "phase" : "remaining";
			const specPaths = getSpecPaths(task, project);
			const specDirs = allSpecDirs(specPaths);

			let keepSession: boolean;
			try {
				const settings = readSettingsFile() as EngineSeedSettings | undefined;
				const current = taskEngineFromMetadata(
					task.metadata,
					settings,
					project.settings?.provider,
				);
				const fromPhase = enginePhaseForPause(
					task.metadata?.paused?.paused_phase ??
						currentPausePhase(task, specPaths),
				);
				const before = current[fromPhase];
				const sameProvider =
					before.provider.toLowerCase() === provider.toLowerCase();
				const trio = {
					provider,
					model:
						chosenModel ||
						(sameProvider
							? before.model
							: seedEngine(settings, provider)[fromPhase].model),
					effort: chosenEffort || before.effort,
				};
				const next = applyEngineChange(current, trio, fromPhase, changeScope);
				const update = buildEngineMetadata(next);
				// The Claude transcript only fits a resumed phase that stays on Claude.
				keepSession = isClaudeProvider(provider) && isClaudeProvider(before.provider);

				// A formula describes one engine for the whole task; it no longer
				// does once a phase runs on something else.
				const formula = task.metadata?.appliedFormula;
				const formulaStillTrue =
					formula &&
					ENGINE_PHASES.every((phase) =>
						sameTrio(next[phase], {
							provider: formula.provider,
							model: formula.model,
							effort: formula.effort as ThinkingLevel,
						}),
					);

				for (const dir of specDirs) {
					const metadataPath = path.join(dir, "task_metadata.json");
					try {
						const existing = existsSync(metadataPath)
							? JSON.parse(safeReadFileSync(metadataPath) || "{}")
							: {};
						Object.assign(existing, update);
						if (!formulaStillTrue) delete existing.appliedFormula;
						atomicWriteFileSync(
							metadataPath,
							JSON.stringify(existing, null, 2),
						);
						// An older resume path left a single-shot marker here; the
						// locked engine above is the answer now.
						rmSync(path.join(dir, "RESUME_WITH_PROVIDER"), { force: true });
					} catch (err) {
						appLog.warn(
							`[TASK_RESUME_WITH_PROVIDER] Could not update ${metadataPath}:`,
							err,
						);
					}
				}

				// Keep in-memory metadata in sync for the UI.
				if (!task.metadata) task.metadata = {};
				Object.assign(task.metadata, update);
				if (!formulaStillTrue) task.metadata.appliedFormula = undefined;

				appLog.info(
					`[TASK_RESUME_WITH_PROVIDER] Resuming task ${taskId} from ${fromPhase} ` +
						`(${changeScope}) on provider=${trio.provider}, model=${trio.model}, ` +
						`effort=${trio.effort} (${specDirs.length} spec dir(s)).`,
				);
			} catch (err) {
				appLog.error(
					`[TASK_RESUME_WITH_PROVIDER] Failed to prepare resume for task ${taskId}:`,
					err,
				);
				return {
					success: false,
					error:
						err instanceof Error ? err.message : "Failed to update the task engine",
				};
			}

			// A paused task has no process; a task still finishing its step does.
			if (agentManager.isRunning(taskId)) {
				agentManager.killTask(taskId);
				await new Promise<void>((resolve) => setTimeout(resolve, 500));
			}

			return await resumePausedTask(agentManager, taskId, project.id, {
				keepSession,
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
				const failedPaths = getPlanPaths(getSpecPaths(task, project), project);
				for (const planFile of failedPaths.all) {
					await persistPlanStatus(planFile, "human_review", project.id);
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
