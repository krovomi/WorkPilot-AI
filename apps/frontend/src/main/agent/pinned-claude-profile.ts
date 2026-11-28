import type { ClaudeProfile } from "../../shared/types/agent";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { appLog } from "../app-logger";
import { type BestProfileEnvResult, ensureCleanProfileEnv } from "../rate-limit-detector";
import type { TaskProviderPlan } from "./task-provider-env";

/**
 * The Claude profile a task's card or project pins (`ai-account-pins.ts`),
 * when it still exists and has a sign-in folder; otherwise undefined, and the
 * task follows the active profile. Read where the process manager refreshes
 * the token and marks it in use, so both act on the profile the task runs on.
 */
export function pinnedClaudeProfile(
	plan: Pick<TaskProviderPlan, "accounts"> | undefined,
): ClaudeProfile | undefined {
	const id = plan?.accounts?.claude;
	if (!id) return undefined;
	const profile = getClaudeProfileManager().getProfile(id);
	if (!profile?.configDir) {
		appLog.warn("[AiAccounts] pinned Claude profile not found, using the active one");
		return undefined;
	}
	return profile;
}

/**
 * The environment of the pinned Claude profile, or undefined without a usable
 * pin (the caller then takes `getBestAvailableProfileEnv`). A pinned profile is
 * used as it is: no swap away from it on a rate limit and no change of the
 * app's active profile, since the person chose this account for this work.
 */
export function pinnedClaudeProfileEnv(
	plan: Pick<TaskProviderPlan, "accounts"> | undefined,
): BestProfileEnvResult | undefined {
	const profile = pinnedClaudeProfile(plan);
	if (!profile) return undefined;
	return {
		env: ensureCleanProfileEnv(getClaudeProfileManager().getProfileEnv(profile.id)),
		profileId: profile.id,
		profileName: profile.name,
		wasSwapped: false,
	};
}
