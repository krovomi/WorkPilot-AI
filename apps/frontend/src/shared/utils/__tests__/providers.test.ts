import { afterEach, expect, it, vi } from "vitest";
import { getStaticProviders } from "../providers";

afterEach(() => vi.unstubAllGlobals());

it("includes Claude authenticated through CLI OAuth without a saved API key", async () => {
	vi.stubGlobal("electronAPI", {
		checkClaudeOAuth: vi.fn().mockResolvedValue({ isAuthenticated: true }),
	});
	const settings = {};
	const result = await getStaticProviders([], settings);
	expect(result.status.anthropic).toBe(true);
	expect(settings).toEqual({});
});
it("includes OpenAI authenticated through Codex even if Claude detection fails", async () => {
	vi.stubGlobal("electronAPI", {
		checkClaudeOAuth: vi.fn().mockRejectedValue(new Error("unavailable")),
		checkOpenAICodexOAuth: vi.fn().mockResolvedValue({ isAuthenticated: true }),
	});
	const result = await getStaticProviders([], {});
	expect(result.status.openai).toBe(true);
	expect(result.status.anthropic).toBe(false);
});
it("keeps API key configuration available without desktop IPC", async () => {
	vi.stubGlobal("electronAPI", undefined);
	const result = await getStaticProviders([], {
		globalAnthropicApiKey: "test-key",
	});
	expect(result.status.anthropic).toBe(true);
	expect(result.status.openai).toBe(false);
});

it("does not report Copilot configured without a verified session", async () => {
	vi.stubGlobal("electronAPI", {
		invoke: vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: false }),
	});
	expect((await getStaticProviders([], {})).status.copilot).toBe(false);
});
it("does not trust a stale Codex display label", async () => {
	vi.stubGlobal("electronAPI", {
		checkOpenAICodexOAuth: vi
			.fn()
			.mockResolvedValue({ isAuthenticated: false }),
	});
	expect(
		(
			await getStaticProviders([], {
				globalOpenAICodexOAuthToken: "old account",
			})
		).status.openai,
	).toBe(false);
});

it("recognizes a verified Copilot session", async () => {
	vi.stubGlobal("electronAPI", {
		invoke: vi.fn().mockResolvedValue({ installed: true, authenticated: true }),
	});
	expect((await getStaticProviders([], {})).status.copilot).toBe(true);
});
it.each([
	["openai", "globalOpenAIApiKey"],
	["mistral", "globalMistralApiKey"],
	["windsurf", "globalWindsurfApiKey"],
])("refreshes configuration after saving and removing a %s key", async (provider, key) => {
	vi.stubGlobal("electronAPI", undefined);
	expect((await getStaticProviders([], {})).status[provider]).toBe(false);
	expect(
		(await getStaticProviders([], { [key]: "test-key" })).status[provider],
	).toBe(true);
	expect((await getStaticProviders([], { [key]: "" })).status[provider]).toBe(
		false,
	);
});
