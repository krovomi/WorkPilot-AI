import { useCallback, useEffect, useState } from "react";
import { resolvePageLlm } from "../../../../shared/utils/page-llm";
import { useSettingsStore } from "../../../stores/settings-store";

/**
 * Whether an API profile is active: the store when it already knows, the
 * main process otherwise.
 */
async function resolveHasAPIProfile(profileId?: string | null): Promise<boolean> {
	if (profileId && profileId !== "") {
		return true;
	}
	try {
		const profilesResult = await window.electronAPI.getAPIProfiles();
		return Boolean(
			profilesResult.success &&
				profilesResult.data?.activeProfileId &&
				profilesResult.data.activeProfileId !== "",
		);
	} catch {
		return false;
	}
}

/**
 * Whether the ideation page can start a generation.
 *
 * Ideation runs on the provider of its page (`resolvePageLlm`, the same answer
 * the main process uses to spawn the runner). Only Claude needs a credential
 * the renderer can check here: the OAuth token of the source `.env`
 * (`checkSourceToken`) or an active API profile (Anthropic-compatible
 * endpoint). Another provider (Codex, Copilot, Gemini, Ollama…) is not gated
 * on Claude's credentials: the runner reports its own sign-in error.
 *
 * The check runs once per provider and profile change, and again on
 * `checkAuth`; it used to re-run after every render (a dependency recreated
 * on each render), calling both IPC channels in a loop while the page was open.
 *
 * @returns { hasToken, isLoading, error, checkAuth }
 */
export function useIdeationAuth() {
	const [hasToken, setHasToken] = useState<boolean | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const activeProfileId = useSettingsStore((state) => state.activeProfileId);
	const provider = useSettingsStore(
		(state) => resolvePageLlm(state.settings, "ideation").provider,
	);
	// "" means no provider named anywhere: the backend default, Claude.
	const needsClaudeCredential = provider === "" || provider === "claude";

	const checkAuth = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			if (!needsClaudeCredential) {
				setHasToken(true);
				return;
			}
			const sourceTokenResult = await window.electronAPI.checkSourceToken();
			const hasSourceOAuthToken =
				sourceTokenResult.success && sourceTokenResult.data?.hasToken;
			const hasAPIProfile = await resolveHasAPIProfile(activeProfileId);
			setHasToken(Boolean(hasSourceOAuthToken || hasAPIProfile));
		} catch (err) {
			setHasToken(false);
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsLoading(false);
		}
	}, [activeProfileId, needsClaudeCredential]);

	useEffect(() => {
		void checkAuth();
	}, [checkAuth]);

	return { hasToken, isLoading, error, checkAuth };
}
