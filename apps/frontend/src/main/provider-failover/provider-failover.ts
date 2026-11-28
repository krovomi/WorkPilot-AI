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
 * auto-switch always did. Changing to an account of Settings → AI accounts
 * (`account-<id>`) pins that account on the stopped task only (its
 * `aiAccounts` in task_metadata.json): the provider's default, and so every
 * other task, stays as it is.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { getProvider as getRegistryProvider } from "../../shared/services/providerRegistry";
import type { ClaudeProfile } from "../../shared/types/agent";
import type { AiAccountView } from "../../shared/types/ai-accounts";
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
import { aiAccountStore } from "../ai-accounts/ai-accounts";
import type { ExecutionProgressData } from "../agent/types";
import { appLog } from "../app-logger";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { resumeTaskWithProvider } from "../ipc-handlers/task/resume-with-provider";
import { loadProfilesFile, setActiveAPIProfile } from "../services/profile/profile-manager";
import {
	accountPinKey,
	excludedEntries,
	FAILOVER_REQUEST_EVENT,
	type FailoverReason,
	type StoppedTask,
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
/**
 * How long an entry a task left is skipped by every other task: a rate limit
 * or a spent quota lifts within the hour, a refused key needs the person.
 * Claude accounts are not counted here: their limits are recorded with the
 * reset time Claude gives (`isProfileRateLimited`).
 */
const COOLDOWN_MS: Readonly<Record<FailoverReason, number>> = {
	rate_limit: 60 * 60 * 1000,
	auth_failure: 6 * 60 * 60 * 1000,
};

interface TaskFailoverState {
	readonly tried: Set<string>;
	moves: number;
	lastAt: number;
}

const states = new Map<string, TaskFailoverState>();
const inFlight = new Set<string>();
/** Entry id → until when no task moves to it (it just stopped one). */
const coolingDown = new Map<string, number>();

/** Whether `entryId` stopped a task lately, for any task. */
export function isCoolingDown(entryId: string, now: number = Date.now()): boolean {
	return (coolingDown.get(entryId) ?? 0) > now;
}

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
	coolingDown.clear();
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
 * their saved order: what the Claude-only auto-switch did. AI accounts the
 * order does not name yet follow, in the order they were added: the page
 * shows them there too.
 */
export function buildFailoverChain(
	order: readonly string[],
	claudeProfiles: readonly ClaudeProfile[],
	apiProfiles: readonly APIProfile[],
	aiAccounts: readonly AiAccountView[] = [],
): FailoverCandidate[] {
	const named = order.length > 0 ? order : claudeProfiles.map((p) => failoverEntryId("oauth", p.id));
	const unnamed = aiAccounts
		.map((account) => failoverEntryId("account", account.id))
		.filter((id) => !named.includes(id));
	const chain: FailoverCandidate[] = [];
	for (const id of [...named, ...unnamed]) {
		const entry = parseFailoverEntry(id);
		if (!entry) continue;
		if (entry.kind === "account") {
			const account = aiAccounts.find((a) => a.id === entry.key);
			if (account) chain.push({ ...entry, provider: account.provider });
		} else if (entry.kind === "oauth") {
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

/** The AI accounts, or none when the store cannot be read now. */
function readAiAccounts(): { accounts: AiAccountView[]; defaults: Record<string, string> } {
	try {
		const store = aiAccountStore();
		return { accounts: store.list(), defaults: store.defaults() };
	} catch (error) {
		appLog.warn("[ProviderFailover] AI accounts unreadable:", (error as Error).message);
		return { accounts: [], defaults: {} };
	}
}

/**
 * The entry a task off Claude ran on: its pinned account, else its
 * provider's default account, else the provider itself (its main key, a CLI).
 */
export function offClaudeEntry(
	stopped: Pick<StoppedTask, "provider" | "pinKey" | "pinnedAccount">,
	accounts: readonly AiAccountView[],
	defaults: Readonly<Record<string, string>>,
): string {
	const own = (id: string | undefined) =>
		id !== undefined && accounts.some((a) => a.id === id && a.provider === stopped.pinKey);
	if (own(stopped.pinnedAccount)) return failoverEntryId("account", stopped.pinnedAccount as string);
	const fallback = stopped.pinKey ? defaults[stopped.pinKey] : undefined;
	if (own(fallback)) return failoverEntryId("account", fallback as string);
	return failoverEntryId("provider", stopped.provider);
}

/** How the task log names an entry: the account's own name when it has one. */
function entryLabel(
	candidate: FailoverCandidate,
	accounts: readonly AiAccountView[],
	claudeProfiles: readonly ClaudeProfile[],
): string {
	const name =
		candidate.kind === "account"
			? accounts.find((a) => a.id === candidate.key)?.name
			: candidate.kind === "oauth"
				? claudeProfiles.find((p) => p.id === candidate.key)?.name
				: undefined;
	return name ? `${candidate.provider} (${name})` : candidate.provider;
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
		const { accounts, defaults } = readAiAccounts();
		const chain = buildFailoverChain(
			normalizeFailoverOrder(profileManager.getAccountPriorityOrder()) ?? [],
			claudeProfiles,
			profilesFile.profiles,
			accounts,
		);
		const onClaude = isClaudeProvider(stopped.provider);
		const pinnedClaude =
			onClaude && claudeProfiles.some((p) => p.id === stopped.pinnedAccount)
				? stopped.pinnedAccount
				: undefined;
		const currentEntryId = !onClaude
			? offClaudeEntry(stopped, accounts, defaults)
			: profilesFile.activeProfileId
				? failoverEntryId("api", profilesFile.activeProfileId)
				: failoverEntryId("oauth", pinnedClaude ?? profileManager.getActiveProfile().id);
		state.tried.add(currentEntryId);
		// Claude accounts keep their own limit record, with its reset time.
		if (parseFailoverEntry(currentEntryId)?.kind !== "oauth") {
			coolingDown.set(currentEntryId, now + COOLDOWN_MS[reason]);
		}

		const target = pickNextFailover(chain, {
			provider: stopped.provider,
			currentEntryId,
			tried: state.tried,
			excluded: excludedEntries(),
			sameProviderFirst: profileManager.getAutoSwitchSettings().sameProviderFirst !== false,
			isUsable: (candidate) => {
				if (isCoolingDown(candidate.id, now)) return false;
				if (candidate.kind === "account") {
					return accounts.some((a) => a.id === candidate.key && a.hasKey);
				}
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
		// The account this task, and only this task, runs on from now on.
		const pinKey = accountPinKey(target.provider);
		const accountPin =
			pinKey && (target.kind === "account" || target.kind === "oauth")
				? { key: pinKey, id: target.key }
				: undefined;
		const result = await resumeTaskWithProvider(agentManager, taskId, target.provider, {
			keepClaudeSession: false,
			accountPin,
		});
		if (!result.success) {
			appLog.warn(`[ProviderFailover] task ${taskId}: resume on ${target.provider} failed: ${result.error}`);
			return null;
		}
		taskLog(
			agentManager,
			taskId,
			stopped.projectId,
			`Auto failover (${reason === "rate_limit" ? "limit reached" : "sign-in failed"}): ${stopped.provider} → ${entryLabel(target, accounts, claudeProfiles)}.`,
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
