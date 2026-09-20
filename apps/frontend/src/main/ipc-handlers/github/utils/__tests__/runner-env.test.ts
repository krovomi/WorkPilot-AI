import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAPIProfileEnv = vi.fn();
const mockGetOAuthModeClearVars = vi.fn();
const mockGetPythonEnv = vi.fn();
const mockGetBestAvailableProfileEnv = vi.fn();
const mockGetGitHubTokenForSubprocess = vi.fn();
const mockGetPageProviderEnv = vi.fn();
const mockGetGlobalProviderEnv = vi.fn();

vi.mock("../../../../services/profile", () => ({
	getAPIProfileEnv: (...args: unknown[]) => mockGetAPIProfileEnv(...args),
}));

vi.mock("../../../../agent/env-utils", () => ({
	getOAuthModeClearVars: (...args: unknown[]) =>
		mockGetOAuthModeClearVars(...args),
}));

vi.mock("../../../../python-env-manager", () => ({
	pythonEnvManager: {
		getPythonEnv: () => mockGetPythonEnv(),
	},
}));

vi.mock("../../../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => mockGetBestAvailableProfileEnv(),
}));

// Mock getGitHubTokenForSubprocess to avoid calling gh CLI in tests
// Path is relative to the module being mocked (runner-env.ts), which imports from '../utils'
vi.mock("../../utils", () => ({
	getGitHubTokenForSubprocess: () => mockGetGitHubTokenForSubprocess(),
}));

vi.mock("../../../../services/page-llm-config", () => ({
	getPageProviderEnv: (...args: unknown[]) => mockGetPageProviderEnv(...args),
	getGlobalProviderEnv: () => mockGetGlobalProviderEnv(),
}));

import { getRunnerEnv } from "../runner-env";

describe("getRunnerEnv", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default mock for Python env - minimal env for testing
		mockGetPythonEnv.mockReturnValue({
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONNOUSERSITE: "1",
			PYTHONPATH: "/bundled/site-packages",
		});
		// Default mock for profile env - returns BestProfileEnvResult format
		mockGetBestAvailableProfileEnv.mockReturnValue({
			env: {},
			profileId: "default",
			profileName: "Default",
			wasSwapped: false,
		});
		// Default mock for GitHub token - returns null (no token) by default
		mockGetGitHubTokenForSubprocess.mockResolvedValue(null);
		mockGetPageProviderEnv.mockReturnValue({});
		mockGetGlobalProviderEnv.mockReturnValue({});
	});

	it("merges Python env with API profile env and OAuth clear vars", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_BASE_URL: "https://api.example.com",
		});
		mockGetOAuthModeClearVars.mockReturnValue({
			ANTHROPIC_AUTH_TOKEN: "",
		});

		const result = await getRunnerEnv();

		expect(mockGetOAuthModeClearVars).toHaveBeenCalledWith({
			ANTHROPIC_AUTH_TOKEN: "token",
			ANTHROPIC_BASE_URL: "https://api.example.com",
		});
		// Python env is included first, then overridden by OAuth clear vars
		expect(result).toMatchObject({
			PYTHONPATH: "/bundled/site-packages",
			PYTHONDONTWRITEBYTECODE: "1",
			ANTHROPIC_AUTH_TOKEN: "",
			ANTHROPIC_BASE_URL: "https://api.example.com",
		});
	});

	it("includes extra env values with highest precedence", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({
			ANTHROPIC_AUTH_TOKEN: "token",
		});
		mockGetOAuthModeClearVars.mockReturnValue({});

		const result = await getRunnerEnv({ USE_CLAUDE_MD: "true" });

		expect(result).toMatchObject({
			PYTHONPATH: "/bundled/site-packages",
			ANTHROPIC_AUTH_TOKEN: "token",
			USE_CLAUDE_MD: "true",
		});
	});

	it("includes PYTHONPATH for bundled packages (fixes #139)", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetPythonEnv.mockReturnValue({
			PYTHONPATH: "/app/Contents/Resources/python-site-packages",
		});

		const result = await getRunnerEnv();

		expect(result.PYTHONPATH).toBe(
			"/app/Contents/Resources/python-site-packages",
		);
	});

	it("includes profileEnv for OAuth token (fixes #563)", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetBestAvailableProfileEnv.mockReturnValue({
			env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-123" },
			profileId: "default",
			profileName: "Default",
			wasSwapped: false,
		});

		const result = await getRunnerEnv();

		expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-123");
	});

	it("applies correct precedence order with profileEnv overriding pythonEnv", async () => {
		mockGetPythonEnv.mockReturnValue({
			SHARED_VAR: "from-python",
		});
		mockGetAPIProfileEnv.mockResolvedValue({
			SHARED_VAR: "from-api-profile",
		});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetBestAvailableProfileEnv.mockReturnValue({
			env: { SHARED_VAR: "from-profile" },
			profileId: "default",
			profileName: "Default",
			wasSwapped: false,
		});

		const result = await getRunnerEnv({ SHARED_VAR: "from-extra" });

		// extraEnv has highest precedence
		expect(result.SHARED_VAR).toBe("from-extra");
	});

	it("includes GitHub token from gh CLI when available (fixes #151)", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetGitHubTokenForSubprocess.mockResolvedValue("gh-token-123");

		const result = await getRunnerEnv();

		expect(result.GITHUB_TOKEN).toBe("gh-token-123");
	});

	it("omits GITHUB_TOKEN when gh CLI returns null", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetGitHubTokenForSubprocess.mockResolvedValue(null);

		const result = await getRunnerEnv();

		expect(result.GITHUB_TOKEN).toBeUndefined();
	});

	it("uses the calling page's provider when one is named", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetPageProviderEnv.mockReturnValue({
			SELECTED_LLM_PROVIDER: "copilot",
		});

		const result = await getRunnerEnv(undefined, { page: "github-prs" });

		expect(mockGetPageProviderEnv).toHaveBeenCalledWith("github-prs");
		expect(mockGetGlobalProviderEnv).not.toHaveBeenCalled();
		expect(result.SELECTED_LLM_PROVIDER).toBe("copilot");
	});

	// Une surface hors de `PAGE_LLM_FEATURES` ne recevait aucun
	// SELECTED_LLM_PROVIDER : le backend repartait sur son propre défaut et la
	// liste « Fournisseur IA » ne voulait rien dire pour elle.
	it("falls back to the global provider when the caller names no page", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetGlobalProviderEnv.mockReturnValue({
			SELECTED_LLM_PROVIDER: "openai",
			OPENAI_API_KEY: "key",
		});

		const result = await getRunnerEnv();

		expect(mockGetPageProviderEnv).not.toHaveBeenCalled();
		expect(result.SELECTED_LLM_PROVIDER).toBe("openai");
		expect(result.OPENAI_API_KEY).toBe("key");
	});

	it("still lets extraEnv override the provider it resolved", async () => {
		mockGetAPIProfileEnv.mockResolvedValue({});
		mockGetOAuthModeClearVars.mockReturnValue({});
		mockGetGlobalProviderEnv.mockReturnValue({
			SELECTED_LLM_PROVIDER: "openai",
		});

		const result = await getRunnerEnv({ SELECTED_LLM_PROVIDER: "ollama" });

		expect(result.SELECTED_LLM_PROVIDER).toBe("ollama");
	});
});
