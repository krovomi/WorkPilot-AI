import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { IPCResult } from "../../../shared/types";
import type { ThinkingLevel } from "../../../shared/types/settings";
import { siblingPinKeys } from "../../../shared/utils/ai-account-pins";
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
import type { AgentManager } from "../../agent/agent-manager";
import { taskEngineFromMetadata } from "../../agent/task-provider-env";
import { appLog } from "../../app-logger";
import { readSettingsFile } from "../../settings-utils";
import { atomicWriteFileSync, safeReadFileSync } from "./execution-utils";
import {
	allSpecDirs,
	currentPausePhase,
	getSpecPaths,
	resumePausedTask,
} from "./resume-task";
import { findTaskAndProject } from "./shared";

export interface EngineChoice {
	readonly model?: string;
	readonly effort?: string;
	readonly scope?: EngineChangeScope;
	/**
	 * Hand the Claude session back to the SDK when the phase stays on Claude.
	 * False when the account changed: another account has no such session.
	 */
	readonly keepClaudeSession?: boolean;
	/**
	 * The account this task runs on from now on, written into its
	 * `aiAccounts` pins (`provider` → account id; `claude` for a Claude
	 * profile). Set by the automatic failover only, never from the renderer.
	 */
	readonly accountPin?: { readonly key: string; readonly id: string };
}

/**
 * The task's pins with `pin` set, keeping the other providers' pins. A pin of
 * the same engine under another key is dropped: an OpenAI key pin would win
 * over the Codex sign-in the failover moved to.
 */
export function withAccountPin(
	existing: unknown,
	pin: { readonly key: string; readonly id: string },
): Record<string, string> {
	const pins: Record<string, string> = {};
	if (existing && typeof existing === "object" && !Array.isArray(existing)) {
		for (const [key, value] of Object.entries(existing)) {
			if (typeof value === "string") pins[key] = value;
		}
	}
	for (const sibling of siblingPinKeys(pin.key)) delete pins[sibling];
	pins[pin.key] = pin.id;
	return pins;
}

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
 *
 * Used by the task's « Reprendre avec… » (TASK_RESUME_WITH_PROVIDER) and by the
 * automatic failover (main/provider-failover), which moves a task stopped on a
 * limit to the next provider of the chain.
 */
export async function resumeTaskWithProvider(
	agentManager: AgentManager,
	taskId: string,
	providerName: string,
	{ model, effort, scope, keepClaudeSession = true, accountPin }: EngineChoice = {},
): Promise<IPCResult> {
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
	// The renderer is not trusted: a model that is not text is no model.
	const chosenModel =
		(typeof model === "string" && model.trim()) || undefined;
	// Validate the effort against the known thinking levels; ignore garbage
	// so a malformed value never poisons task_metadata.json.
	const VALID_EFFORTS = ["none", "low", "medium", "high", "ultrathink"];
	const chosenEffort =
		typeof effort === "string" && VALID_EFFORTS.includes(effort.trim())
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
		keepSession =
			keepClaudeSession &&
			isClaudeProvider(provider) &&
			isClaudeProvider(before.provider);

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
				if (accountPin) existing.aiAccounts = withAccountPin(existing.aiAccounts, accountPin);
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
		if (accountPin) {
			const memory = task.metadata as { aiAccounts?: unknown };
			memory.aiAccounts = withAccountPin(memory.aiAccounts, accountPin);
		}

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
}
