import { buildJevEnvironment } from "../../../jev/environment";
import { getOAuthModeClearVars } from "../../../agent/env-utils";
import type { PageLlmPage } from "../../../../shared/utils/page-llm";
import { pythonEnvManager } from "../../../python-env-manager";
import { getBestAvailableProfileEnv } from "../../../rate-limit-detector";
import {
	getGlobalProviderEnv,
	getPageProviderEnv,
} from "../../../services/page-llm-config";
import { getAPIProfileEnv } from "../../../services/profile";
import { getGitHubTokenForSubprocess } from "../utils";

/**
 * Get environment variables for Python runner subprocesses.
 *
 * Environment variable precedence (lowest to highest):
 * 1. pythonEnv - Python environment including PYTHONPATH for bundled packages (fixes #139)
 * 2. apiProfileEnv - Custom Anthropic-compatible API profile (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)
 * 3. oauthModeClearVars - Clears stale ANTHROPIC_* vars when in OAuth mode
 * 4. profileEnv - Claude OAuth token from profile manager (CLAUDE_CODE_OAUTH_TOKEN)
 * 5. githubEnv - Fresh GitHub token from gh CLI (GITHUB_TOKEN) - fetched on each call to reflect account changes
 * 6. providerEnv - Provider selected for the calling page, or the global one
 *    from the "Fournisseur IA" list when the caller names no page
 *    (SELECTED_LLM_PROVIDER + its key)
 * 7. extraEnv - Caller-specific vars (e.g., USE_CLAUDE_MD)
 *
 * NOTE: extraEnv can intentionally override any of the above, including GITHUB_TOKEN.
 * This allows callers to provide their own token for testing or special cases.
 *
 * The pythonEnv is critical for packaged apps (#139) - without PYTHONPATH, Python
 * cannot find bundled dependencies like dotenv, claude_agent_sdk, etc.
 *
 * The profileEnv is critical for OAuth authentication (#563) - it retrieves the
 * decrypted OAuth token from the profile manager's encrypted storage (macOS Keychain
 * via Electron's safeStorage API).
 *
 * The githubEnv is critical for GitHub operations (#151) - it fetches a fresh token
 * from the gh CLI on each call to ensure account changes are reflected immediately.
 */
export async function getRunnerEnv(
	extraEnv?: Record<string, string>,
	options?: { page?: PageLlmPage; jevWorkflow?: string },
): Promise<Record<string, string>> {
	const pythonEnv = pythonEnvManager.getPythonEnv();
	const apiProfileEnv = await getAPIProfileEnv();
	const oauthModeClearVars = getOAuthModeClearVars(apiProfileEnv);
	// Get best available Claude profile environment (automatically handles rate limits)
	const profileResult = getBestAvailableProfileEnv();
	const profileEnv = profileResult.env;

	// Fetch fresh GitHub token from gh CLI (no caching to reflect account changes)
	const githubToken = await getGitHubTokenForSubprocess();
	const githubEnv: Record<string, string> = githubToken
		? { GITHUB_TOKEN: githubToken }
		: {};

	// Le fournisseur de la page qui lance ce runner : son choix propre, sinon
	// celui de la liste « Fournisseur IA ». Sans SELECTED_LLM_PROVIDER une revue
	// de PR repartait sur Claude quel que soit le fournisseur affiché.
	//
	// Une surface hors de `PAGE_LLM_FEATURES` — génération de tests, auto-fix,
	// auto-réparation — n'a pas de formule propre, mais elle n'a pas pour autant
	// demandé à ignorer le choix global : elle reçoit donc le fournisseur des
	// réglages, exactement ce qu'une page sans surcharge reçoit.
	const providerEnv = options?.page
		? getPageProviderEnv(options.page)
		: getGlobalProviderEnv();

	return buildJevEnvironment(
		{
			...pythonEnv, // Python environment including PYTHONPATH (fixes #139)
			...apiProfileEnv,
			...oauthModeClearVars,
			...profileEnv, // OAuth token from profile manager (fixes #563, rate-limit aware)
			...githubEnv, // Fresh GitHub token from gh CLI (fixes #151)
			...providerEnv, // Provider of the calling page (SELECTED_LLM_PROVIDER + key)
			...extraEnv,
		},
		options?.jevWorkflow,
	);
}
