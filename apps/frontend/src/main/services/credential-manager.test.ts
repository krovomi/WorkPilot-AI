import { describe, expect, it, vi } from "vitest";

// credential-manager pulls in electron transitively (profile-manager needs
// `app.getPath`). The predicate under test is pure, so stub the file-I/O
// modules rather than booting an Electron environment.
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../utils/profile-manager", () => ({
	loadProfilesFile: vi.fn(),
	saveProfilesFile: vi.fn(),
}));
vi.mock("../settings-utils", () => ({
	readSettingsFile: vi.fn(),
	writeSettingsFile: vi.fn(),
}));

import { readSettingsFile } from "../settings-utils";
import { CredentialManager, isPlaceholderApiKey } from "./credential-manager";

describe("isPlaceholderApiKey", () => {
	it.each([
		["", "empty"],
		["   ", "whitespace only"],
		["sk-ant-placeholder", "contains placeholder"],
		["test-abcdef", "test- prefix"],
		["sk-ant-test01-xxxxxxxxxxxxxxxxxxxxxxxxxxx", "sk-ant-test prefix"],
	])("treats %j as a placeholder (%s)", (key) => {
		expect(isPlaceholderApiKey(key)).toBe(true);
	});

	it.each([undefined, null])("treats %j as a placeholder", (key) => {
		expect(isPlaceholderApiKey(key)).toBe(true);
	});

	it("keeps real long provider keys", () => {
		expect(isPlaceholderApiKey(`sk-ant-api03-${"a".repeat(60)}`)).toBe(false);
		expect(isPlaceholderApiKey(`sk-proj-${"b".repeat(40)}`)).toBe(false);
	});

	// The regression this predicate exists for: WorkPilot advertises support for
	// "any OpenAI-compatible endpoint", and local runtimes are conventionally
	// configured with short throwaway keys. The previous `length < 20` rule
	// classified all of these as fake and deleted the profiles on startup.
	it.each(["ollama", "sk-local", "lm-studio", "dummy", "none", "EMPTY"])(
		"keeps short local-runtime key %j",
		(key) => {
			expect(isPlaceholderApiKey(key)).toBe(false);
		},
	);
});

describe("CredentialManager OpenAI environment", () => {
	it("routes Codex CLI mode without exporting saved OAuth display data", () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			selectedProvider: "openai",
			globalOpenAIAuthMode: "codex-cli",
			globalOpenAICodexOAuthToken: "display@example.com",
		});

		const env = new CredentialManager().getEnvironmentVariables();

		expect(env.SELECTED_LLM_PROVIDER).toBe("openai");
		expect(env.OPENAI_AUTH_MODE).toBe("codex-cli");
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(Object.values(env)).not.toContain("display@example.com");
	});

	it("keeps API-key mode as the compatibility default", () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			selectedProvider: "openai",
			globalOpenAIApiKey: "sk-real-key",
		});

		const env = new CredentialManager().getEnvironmentVariables();

		expect(env.SELECTED_LLM_PROVIDER).toBe("openai");
		expect(env.OPENAI_AUTH_MODE).toBe("api-key");
		expect(env.OPENAI_API_KEY).toBe("sk-real-key");
	});
});

describe("CredentialManager Codex CLI status", () => {
	it("does not trust a saved display label when live credentials are absent", async () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			globalOpenAICodexOAuthToken: "stale@example.com",
		});
		const checkCodexLogin = vi.fn().mockResolvedValue(false);

		const status =
			await new CredentialManager(
				checkCodexLogin,
			).checkOpenAICodexOAuthStatusPublic();

		expect(status).toEqual({ isAuthenticated: false });
		expect(checkCodexLogin).toHaveBeenCalledOnce();
	});

	it("does not classify an OpenAI API key as Codex CLI login", async () => {
		vi.mocked(readSettingsFile).mockReturnValue({
			globalOpenAIApiKey: "sk-real-key",
		});

		const status = await new CredentialManager(
			vi.fn().mockResolvedValue(false),
		).checkOpenAICodexOAuthStatusPublic();

		expect(status).toEqual({ isAuthenticated: false });
	});

	it("reports a live Codex CLI session without reading token files", async () => {
		const status = await new CredentialManager(
			vi.fn().mockResolvedValue(true),
		).checkOpenAICodexOAuthStatusPublic();

		expect(status).toEqual({
			isAuthenticated: true,
			profileName: "OpenAI Codex CLI",
		});
	});
});
