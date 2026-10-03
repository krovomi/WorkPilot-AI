import { describe, expect, it, vi } from "vitest";

vi.mock("../services/credential-manager", () => ({
	credentialManager: { getEnvironmentVariables: vi.fn(() => ({})) },
}));
vi.mock("../project-store", () => ({
	projectStore: { getProjects: vi.fn(() => []) },
}));
vi.mock("../settings-utils", () => ({ readSettingsFile: vi.fn(() => ({})) }));
vi.mock("../app-logger", () => ({ appLog: { warn: vi.fn(), info: vi.fn() } }));

import {
	buildTaskProviderEnv,
	planTaskProviders,
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
