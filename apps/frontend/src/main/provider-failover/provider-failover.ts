/**
 * Automatic failover across providers (Settings → AI accounts → Auto failover).
 *
 * A task that stops on a limit or a sign-in failure moves to the next entry of
 * the chain the person ordered: another Claude account, an API profile, or
 * another provider (Copilot, OpenAI, Mistral, Ollama, a coding-agent CLI...).
 *
 * Two signals start it:
 * - the backend pauses the task (`rate_limit_paused`, `auth_failure_paused`):
 *   the task waits in its process, which is stopped and resumed elsewhere;
 * - the process exits on a limit (agent-process), asked here with
 *   `provider-failover-request`.
 *
 * Changing provider goes through `resumeTaskWithProvider`, the path of the
 * task's own « Reprendre avec… »: the engine is written into task_metadata.json
 * from the stopped phase on, and the conversation log carries the context.
 * Changing Claude account sets the active profile first, as the Claude-only
 * auto-switch always did.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { getProvider as getRegistryProvider } from "../../shared/services/providerRegistry";
import type { ClaudeProfile } from "../../shared/types/agent";
import type { APIProfile } from "../../shared/types/profile";
import {
	apiProfileProvider,
	type FailoverCandidate,
	failoverEntryId,
	normalizeFailoverOrder,
	parseFailoverEntry,
	pickNextFailover,
} from "../../shared/utils/failover-chain";
import {
	isClaudeProvider,
} from "../../shared/utils/task-engine";
import type { AgentManager } from "../agent/agent-manager";
import type { ExecutionProgressData } from "../agent/types";
import { appLog } from "../app-logger";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { resumeTaskWithProvider } from "../ipc-handlers/task/resume-with-provider";
import { loadProfilesFile, setActiveAPIProfile } from "../services/profile/profile-manager";
import {
	excludedEntries,
	FAILOVER_REQUEST_EVENT,
	type FailoverReason,
	stoppedTask,
} from "./task-phase-provider";

export { FAILOVER_REQUEST_EVENT, type FailoverReason };

const PAUSE_PHASES: Readonly<Record<string, FailoverReason>> = {
	rate_limit_paused: "rate_limit",
	auth_failure_paused: "auth_failure",
};

/** Limits reset within hours: an entry tried for a task is skipped that long. */
const TRIED_TTL_MS = 6 * 60 * 60 * 1000;
/** Late events of the stopped process are not a second failure. */
const SETTLE_MS = 30_000;
/** More moves than any chain needs; past it the task stays where it stopped. */
const MAX_MOVES_PER_TASK = 6;

interface TaskFailoverState {
	readonly tried: Set<string>;
	moves: number;
	lastAt: number;
}

const states = new Map<string, TaskFailoverState>();
const inFlight = new Set<string>();

function stateFor(taskId: string, now: number): TaskFailoverState {
	const existing = states.get(taskId);
	if (existing && now - existing.lastAt < TRIED_TTL_MS) return existing;
	const fresh: TaskFailoverState = { tried: new Set(), moves: 0, lastAt: 0 };
	states.set(taskId, fresh);
	return fresh;
}

/** Forget every task (tests). */
export function resetProviderFailoverState(): void {
	states.clear();
	inFlight.clear();
}

/** Whether the person switched the failover on for this reason. */
export function failoverEnabledFor(reason: FailoverReason): boolean {
	const settings = getClaudeProfileManager().getAutoSwitchSettings();
	if (!settings.enabled) return false;
	return reason === "rate_limit"
		? settings.autoSwitchOnRateLimit
		: settings.autoSwitchOnAuthFailure;
}

/**
 * The chain as stored, each entry with its provider. Entries whose account no
 * longer exists are dropped. With no order saved yet, the Claude accounts in
 * their saved order: what the Claude-only auto-switch did.
 */
export function buildFailoverChain(
	order: readonly string[],
	claudeProfiles: readonly ClaudeProfile[],
	apiProfiles: readonly APIProfile[],
): FailoverCandidate[] {
	const ids = order.length > 0 ? order : claudeProfiles.map((p) => failoverEntryId("oauth", p.id));
	const chain: FailoverCandidate[] = [];
	for (const id of ids) {
		const entry = parseFailoverEntry(id);
		if (!entry) continue;
		if (entry.kind === "oauth") {
			if (claudeProfiles.some((p) => p.id === entry.key)) {
				chain.push({ ...entry, provider: "anthropic" });
			}
		} else if (entry.kind === "api") {
			const profile = apiProfiles.find((p) => p.id === entry.key);
			if (profile) chain.push({ ...entry, provider: apiProfileProvider(profile) });
		} else if (getRegistryProvider(entry.key)) {
			chain.push({ ...entry, provider: entry.key });
		}
	}
	return chain;
}

function taskLog(agentManager: AgentManager, taskId: string, projectId: string, line: string): void {
	agentManager.emit("log", taskId, `\n[WorkPilot] ${line}\n`, projectId);
}

/**
 * Move a stopped task to the next entry of the chain. Resolves to the entry it
 * moved to, or null when it stays where it stopped.
 */
export async function failTaskOver(
	agentManager: AgentManager,
	taskId: string,
	reason: FailoverReason,
	projectId?: string,
	now: number = Date.now(),
): Promise<FailoverCandidate | null> {
	if (!failoverEnabledFor(reason) || inFlight.has(taskId)) return null;
	const state = stateFor(taskId, now);
	if (now - state.lastAt < SETTLE_MS || state.moves >= MAX_MOVES_PER_TASK) return null;
	const stopped = stoppedTask(taskId, projectId);
	if (!stopped) return null;

	inFlight.add(taskId);
	try {
		const profileManager = getClaudeProfileManager();
		const profilesFile = await loadProfilesFile();
		const claudeProfiles = profileManager.getSettings().profiles;
		const chain = buildFailoverChain(
			normalizeFailoverOrder(profileManager.getAccountPriorityOrder()) ?? [],
			claudeProfiles,
			profilesFile.profiles,
		);
		const onClaude = isClaudeProvider(stopped.provider);
		const currentEntryId = !onClaude
			? failoverEntryId("provider", stopped.provider)
			: profilesFile.activeProfileId
				? failoverEntryId("api", profilesFile.activeProfileId)
				: failoverEntryId("oauth", profileManager.getActiveProfile().id);
		state.tried.add(currentEntryId);

		const target = pickNextFailover(chain, {
			provider: stopped.provider,
			currentEntryId,
			tried: state.tried,
			excluded: excludedEntries(),
			isUsable: (candidate) => {
				if (candidate.kind === "oauth") {
					return (
						profileManager.hasValidAuth(candidate.key) &&
						!profileManager.isProfileRateLimited(candidate.key).limited
					);
				}
				if (candidate.kind === "api") {
					return Boolean(profilesFile.profiles.find((p) => p.id === candidate.key)?.apiKey);
				}
				return true;
			},
		});
		if (!target) {
			taskLog(agentManager, taskId, stopped.projectId, `Auto failover: no other account available after ${stopped.provider}.`);
			return null;
		}

		// The Claude account (or Anthropic-compatible endpoint) the task will use.
		if (target.kind === "oauth") {
			if (profilesFile.activeProfileId) await setActiveAPIProfile(null);
			profileManager.setActiveProfile(target.key);
		} else if (target.kind === "api" && isClaudeProvider(target.provider)) {
			await setActiveAPIProfile(target.key);
		}
		// The process waiting on the limit would see its pause file again.
		for (const dir of stopped.specDirs) {
			for (const marker of ["RATE_LIMIT_PAUSE", "AUTH_PAUSE"]) {
				rmSync(path.join(dir, marker), { force: true });
			}
		}

		state.tried.add(target.id);
		state.moves += 1;
		state.lastAt = now;
		const result = await resumeTaskWithProvider(agentManager, taskId, target.provider, {
			keepClaudeSession: false,
		});
		if (!result.success) {
			appLog.warn(`[ProviderFailover] task ${taskId}: resume on ${target.provider} failed: ${result.error}`);
			return null;
		}
		taskLog(
			agentManager,
			taskId,
			stopped.projectId,
			`Auto failover (${reason === "rate_limit" ? "limit reached" : "sign-in failed"}): ${stopped.provider} → ${target.provider} (${target.id}).`,
		);
		appLog.info(`[ProviderFailover] task ${taskId}: ${stopped.provider} -> ${target.id}`);
		return target;
	} catch (error) {
		appLog.warn(`[ProviderFailover] task ${taskId}:`, error);
		return null;
	} finally {
		inFlight.delete(taskId);
	}
}

/** Listen for paused tasks and failover requests, once for the app's life. */
export function registerProviderFailover(agentManager: AgentManager): void {
	agentManager.on(
		"execution-progress",
		(taskId: string, progress: ExecutionProgressData, projectId?: string) => {
			const reason = PAUSE_PHASES[progress?.phase ?? ""];
			if (reason) void failTaskOver(agentManager, taskId, reason, projectId);
		},
	);
	agentManager.on(FAILOVER_REQUEST_EVENT, (taskId: string, reason: FailoverReason) => {
		void failTaskOver(agentManager, taskId, reason);
	});
}
