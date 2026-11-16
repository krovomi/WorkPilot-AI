import { describe, expect, it } from "vitest";
import type { APIProfile } from "../../../../shared/types/profile";
import { providerAuthMethod, providerKeyInfo } from "../provider-key-info";

const profile = (name: string, baseUrl: string, apiKey?: string): APIProfile =>
	({ id: name, name, baseUrl, apiKey, apiKeySetAt: 7, createdAt: 0, updatedAt: 0 }) as APIProfile;

describe("providerAuthMethod", () => {
	it("reads how the registry says a provider signs in", () => {
		expect(providerAuthMethod("copilot")).toBe("cli");
		expect(providerAuthMethod("ollama")).toBe("local");
		expect(providerAuthMethod("openai")).toBe("api-key");
		expect(providerAuthMethod("not-a-provider")).toBe("api-key");
	});
});

describe("providerKeyInfo", () => {
	it("prefers an API profile's key, matched by endpoint", () => {
		const profiles = [
			profile("No url", ""),
			profile("Claude proxy", "https://api.anthropic.com", "k"),
			profile("Gemini", "https://generativelanguage.googleapis.com", "k"),
			profile("Bad url", "not a url", "k"),
		];
		expect(providerKeyInfo("claude", profiles, {}, false)).toEqual({
			hasKey: true,
			provider: "Claude proxy",
			authMethod: "api-key",
			setAt: 7,
		});
		expect(providerKeyInfo("google", profiles, {}, false)).toMatchObject({ provider: "Gemini" });
		expect(providerKeyInfo("gemini", profiles, {}, false)).toMatchObject({ provider: "Gemini" });
	});

	it("then the key saved in Settings, with its date", () => {
		expect(
			providerKeyInfo("openai", [], { globalOpenAIApiKey: "••••", credentialsSetAt: { globalOpenAIApiKey: 3 } }, true),
		).toEqual({ hasKey: true, authMethod: "api-key", setAt: 3 });
		expect(providerKeyInfo("openai", [], { globalOpenAIApiKey: "••••" }, true)).toEqual({
			hasKey: true,
			authMethod: "api-key",
			setAt: undefined,
		});
	});

	it("counts a sign-in or a CLI with a profile, and a local provider", () => {
		expect(providerKeyInfo("copilot", [profile("gh", "https://models.github.com")], {}, false)).toEqual({
			hasKey: true,
			provider: "gh",
			authMethod: "cli",
		});
		expect(providerKeyInfo("ollama", [], {}, false)).toEqual({ hasKey: true, authMethod: "local" });
	});

	it("takes a connected provider without a key for signed in", () => {
		expect(providerKeyInfo("copilot", [], {}, true)).toEqual({ hasKey: true, authMethod: "cli" });
		expect(providerKeyInfo("anthropic", [], {}, true)).toEqual({ hasKey: true, authMethod: "oauth" });
		expect(providerKeyInfo("openai", [], {}, true)).toEqual({ hasKey: false, authMethod: "api-key" });
		expect(providerKeyInfo("anthropic", [], {}, false)).toEqual({ hasKey: false, authMethod: providerAuthMethod("anthropic") });
	});
});
