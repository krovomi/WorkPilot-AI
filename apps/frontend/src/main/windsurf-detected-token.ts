/**
 * The Windsurf key found in the local IDE install stays in the main process
 * (rule S6). Detecting tells the renderer that a key was found and for which
 * account; saving it is asked of the main process, which detects it again and
 * writes it to the settings. The renderer keeps MASKED_SECRET in its place.
 */
import type { WindsurfDetection, WindsurfTokenSave } from "../shared/types";
import { prepareSecrets } from "./secret-storage";
import {
	detectWindsurfLocalToken,
	readWindsurfCachedPlanInfo,
} from "./services/credential-manager";
import { readSettingsFile, writeSettingsFile } from "./settings-utils";

/** Whether a Windsurf key is installed locally, with its account and plan. */
export async function detectWindsurfAccount(): Promise<WindsurfDetection> {
	const token = await detectWindsurfLocalToken();
	if (!token.success) return { success: false, error: token.error };
	const account: WindsurfDetection = {
		success: true,
		userName: token.userName,
	};
	try {
		const plan = await readWindsurfCachedPlanInfo();
		if (plan.success && plan.planInfo) {
			const { usage } = plan.planInfo;
			return {
				...account,
				userName: plan.userName || token.userName,
				planName: plan.planInfo.planName,
				usageInfo: {
					usedMessages: usage.usedMessages,
					totalMessages: usage.messages,
					usedFlowActions: usage.usedFlowActions,
					totalFlowActions: usage.flowActions,
				},
			};
		}
	} catch (e) {
		// A cached plan without usage counters: the account is enough.
		console.warn(
			"[CredentialHandlers] Failed to enrich Windsurf token with plan info:",
			e,
		);
	}
	return account;
}

/** Save the locally installed Windsurf key as the global Windsurf key, enabled. */
export async function saveDetectedWindsurfToken(): Promise<WindsurfTokenSave> {
	const token = await detectWindsurfLocalToken();
	if (!token.success || !token.apiKey) {
		return { success: false, error: token.error };
	}
	await prepareSecrets([token.apiKey]);
	const credentialsSetAt = writeSettingsFile({
		...readSettingsFile(),
		globalWindsurfApiKey: token.apiKey,
		globalWindsurfApiKeyEnabled: true,
	});
	return { success: true, credentialsSetAt };
}
