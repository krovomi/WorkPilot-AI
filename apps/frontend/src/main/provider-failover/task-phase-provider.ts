/**
 * What agent-process asks before handing a task to the provider failover
 * (provider-failover.ts): which provider the task's phase runs on, and whether
 * the chain names another provider. Kept apart so agent-process does not load
 * the resume machinery it is itself started by.
 */
import { getProvider as getRegistryProvider } from "../../shared/services/providerRegistry";
import {
	isFailoverEntryExcluded,
	normalizeFailoverOrder,
	parseFailoverEntry,
} from "../../shared/utils/failover-chain";
import {
	type EngineSeedSettings,
	enginePhaseForPause,
	isClaudeProvider,
} from "../../shared/utils/task-engine";
import { taskEngineFromMetadata } from "../agent/task-provider-env";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { allSpecDirs, currentPausePhase, getSpecPaths } from "../ipc-handlers/task/resume-task";
import { findTaskAndProject } from "../ipc-handlers/task/shared";
import { readSettingsFile } from "../settings-utils";

export type FailoverReason = "rate_limit" | "auth_failure";

/** The event agent-process emits when a task exits on a limit it can move from. */
export const FAILOVER_REQUEST_EVENT = "provider-failover-request";

/** The entries the person took out of the chain (Settings, by entry id or provider). */
export function excludedEntries(): string[] {
	const settings = readSettingsFile() as { disabledAutoSwitchProviders?: unknown } | undefined;
	const raw = settings?.disabledAutoSwitchProviders;
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

export interface StoppedTask {
	readonly provider: string;
	readonly projectId: string;
	readonly specDirs: string[];
}

export function stoppedTask(taskId: string, projectId?: string): StoppedTask | null {
	const { task, project } = findTaskAndProject(taskId, projectId);
	if (!task || !project) return null;
	const specPaths = getSpecPaths(task, project);
	const settings = readSettingsFile() as EngineSeedSettings | undefined;
	const engine = taskEngineFromMetadata(task.metadata, settings, project.settings?.provider);
	const phase = enginePhaseForPause(
		task.metadata?.paused?.paused_phase ?? currentPausePhase(task, specPaths),
	);
	return {
		provider: engine[phase].provider.trim().toLowerCase(),
		projectId: project.id,
		specDirs: allSpecDirs(specPaths),
	};
}

/** The provider the task's current phase runs on, or null when unknown. */
export function taskPhaseProvider(taskId: string, projectId?: string): string | null {
	return stoppedTask(taskId, projectId)?.provider ?? null;
}

/**
 * Whether the stored chain names a provider other than Claude that is still
 * in it: a Claude task with no other Claude account can still move.
 */
export function chainHasOtherProvider(): boolean {
	const order = normalizeFailoverOrder(getClaudeProfileManager().getAccountPriorityOrder()) ?? [];
	const excluded = excludedEntries();
	return order.some((id) => {
		const entry = parseFailoverEntry(id);
		return (
			entry?.kind === "provider" &&
			!isClaudeProvider(entry.key) &&
			!isFailoverEntryExcluded(entry, excluded) &&
			getRegistryProvider(entry.key) !== undefined
		);
	});
}

