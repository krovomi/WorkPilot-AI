/**
 * What agent-process asks before handing a task to the provider failover
 * (provider-failover.ts): which provider the task's phase runs on, and whether
 * the chain names another provider. Kept apart so agent-process does not load
 * the resume machinery it is itself started by.
 */
import { getProvider as getRegistryProvider } from "../../shared/services/providerRegistry";
import type { AiAccountPins } from "../../shared/types/ai-accounts";
import { mergeAccountPins, pinKeysOf } from "../../shared/utils/ai-account-pins";
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
	/** The task's account pins: the card's, then its project's (`aiAccounts`). */
	readonly pins?: AiAccountPins;
	/**
	 * The pin keys whose accounts run the provider, in the order the task's
	 * environment applies them (`task-provider-env.ts`): API key first, then a
	 * CLI sign-in (`openai`, then `codex`); `claude` for Claude.
	 */
	readonly pinKeys: readonly string[];
	/**
	 * The key whose default account the task runs on when none is pinned:
	 * `codex` for OpenAI in its Codex mode, else the first of `pinKeys`.
	 */
	readonly defaultKey?: string;
}

/** The key whose default account runs `provider` when the task pins none. */
export function defaultPinKey(
	pinKeys: readonly string[],
	settings: { globalOpenAIAuthMode?: unknown } | undefined,
): string | undefined {
	if (pinKeys.includes("codex") && settings?.globalOpenAIAuthMode === "codex-cli") return "codex";
	return pinKeys[0];
}

export function stoppedTask(taskId: string, projectId?: string): StoppedTask | null {
	const { task, project } = findTaskAndProject(taskId, projectId);
	if (!task || !project) return null;
	const specPaths = getSpecPaths(task, project);
	const settings = readSettingsFile() as (EngineSeedSettings & { globalOpenAIAuthMode?: unknown }) | undefined;
	const engine = taskEngineFromMetadata(task.metadata, settings, project.settings?.provider);
	const phase = enginePhaseForPause(
		task.metadata?.paused?.paused_phase ?? currentPausePhase(task, specPaths),
	);
	const provider = engine[phase].provider.trim().toLowerCase();
	const pinKeys = pinKeysOf(provider);
	return {
		provider,
		projectId: project.id,
		specDirs: allSpecDirs(specPaths),
		pins: mergeAccountPins(
			(task.metadata as { aiAccounts?: unknown } | undefined)?.aiAccounts,
			(project.settings as { aiAccounts?: unknown } | undefined)?.aiAccounts,
		),
		pinKeys,
		defaultKey: defaultPinKey(pinKeys, settings),
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

