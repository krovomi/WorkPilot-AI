import { describe, expect, it, vi } from "vitest";

vi.mock("../services/credential-manager", () => ({
	credentialManager: { getEnvironmentVariables: vi.fn(() => ({})) },
}));
vi.mock("../project-store", () => ({
	projectStore: { getProjects: vi.fn(() => []) },
}));
vi.mock("../settings-utils", () => ({ readSettingsFile: vi.fn(() => ({})) }));
vi.mock("../app-logger", () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));
const applyPinnedAccount = vi.fn(
	(env: Record<string, string>, provider: string, accountId: string | undefined) => {
		if (!accountId) return false;
		env[`${provider.toUpperCase()}_KEY`] = `pinned:${accountId}`;
		return true;
	},
);
vi.mock("../ai-accounts/pinned-account-env", () => ({
	applyPinnedAccount: (...args: Parameters<typeof applyPinnedAccount>) =>
		applyPinnedAccount(...args),
}));

const applyPinnedLogin = vi.fn(
	(env: Record<string, string>, provider: string, accountId: string | undefined) => {
		if (!accountId) return false;
		env[`${provider.toUpperCase()}_HOME`] = `home:${accountId}`;
		return true;
	},
);
vi.mock("../ai-accounts/login-accounts", () => ({
	applyPinnedLogin: (...args: Parameters<typeof applyPinnedLogin>) => applyPinnedLogin(...args),
}));

import {
	buildTaskProviderEnv,
	planTaskProviders,
	taskAccountPins,
	taskEngineFromMetadata,
} from "./task-provider-env";

const lockedMixed = {
	engineLocked: true,
	provider: "ollama",
	phaseProviders: {
		spec: "openai",
		planning: "openai",
		coding: "ollama",
		qa: "anthropic",
	},
	phaseModels: { spec: "gpt-5", planning: "gpt-5", coding: "qwen3", qa: "opus" },
	phaseThinking: {
		spec: "low",
		planning: "low",
		coding: "medium",
		qa: "high",
	},
} as const;

describe("task provider plan", () => {
	it("lists every provider of the task and the starting one", () => {
		const plan = planTaskProviders(
			taskEngineFromMetadata({ ...lockedMixed }, {}),
			"coding",
		);
		expect(plan.providers).toEqual(["openai", "ollama", "anthropic"]);
		expect(plan.startProvider).toBe("ollama");
		expect(plan.usesClaude).toBe(true);
	});

	it("ignores the default provider of the Settings for a task that names its own", () => {
		const plan = planTaskProviders(
			taskEngineFromMetadata({ ...lockedMixed }, { selectedProvider: "copilot" }),
			"spec",
		);
		expect(plan.providers).not.toContain("copilot");
		expect(plan.startProvider).toBe("openai");
	});
});

describe("buildTaskProviderEnv", () => {
	it("merges the credentials of every non-Claude provider and names the starting one", () => {
		const getEnv = vi.fn((provider: string) => ({
			SELECTED_LLM_PROVIDER: provider,
			[`${provider.toUpperCase()}_KEY`]: "k",
		}));
		const env = buildTaskProviderEnv(
			{
				providers: ["openai", "ollama", "anthropic"],
				startProvider: "ollama",
				usesClaude: true,
			},
			getEnv,
		);
		expect(getEnv).toHaveBeenCalledTimes(2);
		expect(getEnv).not.toHaveBeenCalledWith("anthropic");
		expect(env.OPENAI_KEY).toBe("k");
		expect(env.OLLAMA_KEY).toBe("k");
		expect(env.SELECTED_LLM_PROVIDER).toBe("ollama");
	});

	it("names Claude as claude when the task starts on Anthropic", () => {
		const env = buildTaskProviderEnv(
			{ providers: ["anthropic"], startProvider: "anthropic", usesClaude: true },
			() => ({ SELECTED_LLM_PROVIDER: "copilot" }),
		);
		expect(env.SELECTED_LLM_PROVIDER).toBe("claude");
	});

	it("keeps going when one provider's credentials cannot be read", () => {
		const env = buildTaskProviderEnv(
			{ providers: ["openai", "mistral"], startProvider: "mistral", usesClaude: false },
			(provider) => {
				if (provider === "openai") throw new Error("locked keychain");
				return { MISTRAL_API_KEY: "m" };
			},
		);
		expect(env.MISTRAL_API_KEY).toBe("m");
		expect(env.SELECTED_LLM_PROVIDER).toBe("mistral");
	});
});

describe("pinned accounts", () => {
	it("runs each provider on the account the card or its project pins", () => {
		const env = buildTaskProviderEnv(
			{
				providers: ["openai", "gemini", "mistral"],
				startProvider: "openai",
				usesClaude: false,
				accounts: { openai: "client", google: "work" },
			},
			(provider) => ({ [`${provider.toUpperCase()}_KEY`]: "default" }),
		);
		expect(env.OPENAI_KEY).toBe("pinned:client");
		expect(env.GEMINI_KEY).toBe("pinned:work");
		expect(env.MISTRAL_KEY).toBe("default");
	});

	it("points each CLI at its pinned sign-in, over the default folder every provider carries", () => {
		const env = buildTaskProviderEnv(
			{
				providers: ["copilot", "mistral"],
				startProvider: "copilot",
				usesClaude: false,
				accounts: { copilot: "work" },
			},
			() => ({ COPILOT_HOME: "default" }),
		);
		expect(env.COPILOT_HOME).toBe("home:work");
	});

	it("keeps OpenAI on its pinned key rather than a Codex sign-in", () => {
		applyPinnedLogin.mockClear();
		const env = buildTaskProviderEnv(
			{
				providers: ["openai"],
				startProvider: "openai",
				usesClaude: false,
				accounts: { openai: "key", codex: "plan" },
			},
			() => ({}),
		);
		expect(env.OPENAI_KEY).toBe("pinned:key");
		expect(applyPinnedLogin).not.toHaveBeenCalled();
	});

	it("takes the card's pin over the project's, the project's for the rest", () => {
		expect(
			taskAccountPins(
				{ aiAccounts: { openai: "card" } },
				{ aiAccounts: { openai: "project", anthropic: "team" } },
			),
		).toEqual({ openai: "card", claude: "team" });
		// A card's Codex sign-in replaces the project's OpenAI key, and the reverse.
		expect(
			taskAccountPins({ aiAccounts: { codex: "plan" } }, { aiAccounts: { openai: "key" } }),
		).toEqual({ codex: "plan" });
		expect(
			taskAccountPins({ aiAccounts: { openai: "key" } }, { aiAccounts: { codex: "plan", copilot: "gh" } }),
		).toEqual({ openai: "key", copilot: "gh" });
		expect(taskAccountPins(undefined, undefined)).toBeUndefined();
	});
});
