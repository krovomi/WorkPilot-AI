import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	mainEnv: {} as Record<string, string>,
	pythonEnv: {} as Record<string, string>,
	backendEnv: {} as Record<string, string> | Error,
	profileEnv: {} as Record<string, string>,
	apiProfileEnv: {} as Record<string, string>,
	globalProviderEnv: {} as Record<string, string>,
	pageProviderEnv: {} as Record<string, string>,
	pages: [] as string[],
}));

vi.mock("../../env-utils", () => ({
	getAugmentedEnv: () => ({ ...state.mainEnv }),
}));
vi.mock("../../python-env-manager", () => ({
	pythonEnvManager: { getPythonEnv: () => ({ ...state.pythonEnv }) },
}));
vi.mock("../../source-env", () => ({
	loadBackendEnv: () => {
		if (state.backendEnv instanceof Error) throw state.backendEnv;
		return { ...state.backendEnv };
	},
}));
vi.mock("../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => ({ env: { ...state.profileEnv } }),
}));
vi.mock("../../services/profile", () => ({
	getAPIProfileEnv: async () => ({ ...state.apiProfileEnv }),
}));
vi.mock("../../services/page-llm-config", () => ({
	getGlobalProviderEnv: () => ({ ...state.globalProviderEnv }),
	getPageProviderEnv: (page: string) => {
		state.pages.push(page);
		return { ...state.pageProviderEnv };
	},
}));
vi.mock("../../agent/env-utils", () => ({
	getOAuthModeClearVars: (profile: Record<string, string>) =>
		Object.keys(profile).length > 0
			? {}
			: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
}));

import { pythonRunnerEnv } from "../python-runner-env";

const BACKEND = path.join(path.sep, "app", "backend");

describe("pythonRunnerEnv", () => {
	beforeEach(() => {
		state.mainEnv = {
			PATH: "/usr/bin",
			HOME: "/home/me",
			OPENAI_API_KEY: "sk-test-0000",
			GITHUB_TOKEN: "test-gh-0000",
			CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-shell-0000",
		};
		state.pythonEnv = { PYTHONPATH: "" };
		state.backendEnv = {};
		state.profileEnv = { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-profile-0000" };
		state.apiProfileEnv = {};
		state.globalProviderEnv = {};
		state.pageProviderEnv = {};
		state.pages = [];
	});

	it("keeps what Python needs to run and none of the main env's credentials", async () => {
		state.globalProviderEnv = { SELECTED_LLM_PROVIDER: "mistral" };
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/me");
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it("gives the runner the provider chosen in the app, with its key", async () => {
		state.globalProviderEnv = {
			SELECTED_LLM_PROVIDER: "openai",
			OPENAI_API_KEY: "sk-test-1111",
		};
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.SELECTED_LLM_PROVIDER).toBe("openai");
		expect(env.OPENAI_API_KEY).toBe("sk-test-1111");
	});

	it("uses the calling page's provider when it names a page", async () => {
		state.globalProviderEnv = { SELECTED_LLM_PROVIDER: "openai" };
		state.pageProviderEnv = { SELECTED_LLM_PROVIDER: "google" };
		const env = await pythonRunnerEnv(BACKEND, { page: "insights" });
		expect(state.pages).toEqual(["insights"]);
		expect(env.SELECTED_LLM_PROVIDER).toBe("google");
	});

	it("signs a Claude runner in with the profile's token, not the shell's", async () => {
		state.globalProviderEnv = { SELECTED_LLM_PROVIDER: "claude" };
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-profile-0000");
		expect(env.ANTHROPIC_API_KEY).toBe("");
	});

	it("signs in with Claude when no provider is chosen", async () => {
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-profile-0000");
	});

	it("uses the active API profile instead of the OAuth token", async () => {
		state.apiProfileEnv = {
			ANTHROPIC_BASE_URL: "https://llm.example.test",
			ANTHROPIC_AUTH_TOKEN: "test-profile-0000",
		};
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.example.test");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-profile-0000");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it("gives no Claude sign-in to a runner on another provider", async () => {
		state.globalProviderEnv = { SELECTED_LLM_PROVIDER: "openai" };
		state.apiProfileEnv = { ANTHROPIC_AUTH_TOKEN: "test-profile-0000" };
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it("keeps Copilot on Claude's sign-in, as the agents do", async () => {
		state.globalProviderEnv = { SELECTED_LLM_PROVIDER: "copilot" };
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-profile-0000");
	});

	it("passes the backend .env, and starts without it when it cannot be read", async () => {
		state.backendEnv = { GRAPHITI_ENABLED: "true" };
		expect((await pythonRunnerEnv(BACKEND)).GRAPHITI_ENABLED).toBe("true");
		state.backendEnv = new Error("unreadable");
		expect((await pythonRunnerEnv(BACKEND)).PATH).toBe("/usr/bin");
	});

	it("puts the backend first on PYTHONPATH, then the bundled packages", async () => {
		const bundled = path.join(path.sep, "app", "site-packages");
		state.pythonEnv = {
			PYTHONPATH: [bundled, BACKEND].join(path.delimiter),
		};
		const env = await pythonRunnerEnv(BACKEND);
		expect(env.PYTHONPATH).toBe([BACKEND, bundled].join(path.delimiter));
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.PYTHONIOENCODING).toBe("utf-8");
	});

	it("applies the caller's variables last, connector credentials included", async () => {
		const env = await pythonRunnerEnv(BACKEND, {
			extra: {
				AZURE_DEVOPS_PAT: "test-pat-0000",
				PYTHONUNBUFFERED: "0",
				UNSET: undefined,
			},
		});
		expect(env.AZURE_DEVOPS_PAT).toBe("test-pat-0000");
		expect(env.PYTHONUNBUFFERED).toBe("0");
		expect("UNSET" in env).toBe(false);
	});
});
