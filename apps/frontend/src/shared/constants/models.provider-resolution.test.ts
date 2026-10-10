import { describe, expect, it } from "vitest";
import {
	getModelsForProvider,
	getModelTier,
	isModelForeignToProvider,
	resolveModelForProviderCatalog,
} from "./models";

describe("getModelTier", () => {
	it("derives the tier of a preset alias via canonical identity", () => {
		expect(getModelTier("opus")).toBe("flagship");
		expect(getModelTier("sonnet")).toBe("standard");
		expect(getModelTier("haiku")).toBe("fast");
	});

	it("resolves explicit versioned ids too", () => {
		expect(getModelTier("claude-opus-4-6")).toBe("flagship");
		expect(getModelTier("gpt-5.5-pro")).toBe("flagship");
		expect(getModelTier("gpt-4.1-mini")).toBe("fast");
	});

	it("returns undefined for an unknown model", () => {
		expect(getModelTier("totally-unknown-model")).toBeUndefined();
	});
});

describe("resolveModelForProviderCatalog", () => {
	it("uses the static provider tier when discovery returns no models", () => {
		expect(
			getModelTier(resolveModelForProviderCatalog("sonnet", [], "openai")),
		).toBe("standard");
	});
	it("preserves a custom model when neither catalog is known", () => {
		expect(
			resolveModelForProviderCatalog("my-model", [], "private-server"),
		).toBe("my-model");
	});
	it("returns the first restricted model when no capability tier matches", () => {
		expect(
			resolveModelForProviderCatalog(
				"sonnet",
				[{ value: "account-model" }],
				"openai",
			),
		).toBe("account-model");
	});
	it("never introduces an API-only model into a restricted Codex catalog", () => {
		const catalog = [{ value: "gpt-5.5", tier: "flagship" as const }];
		expect(resolveModelForProviderCatalog("sonnet", catalog, "openai")).toBe(
			"gpt-5.5",
		);
		expect(resolveModelForProviderCatalog("gpt-5.5", catalog, "openai")).toBe(
			"gpt-5.5",
		);
		expect(
			resolveModelForProviderCatalog("gpt-5.5-mini", catalog, "openai"),
		).toBe("gpt-5.5");
	});
	const openai = getModelsForProvider("openai");
	const anthropic = getModelsForProvider("anthropic");

	it("keeps a value already offered by the provider", () => {
		expect(
			resolveModelForProviderCatalog("claude-opus-4-6", anthropic, "anthropic"),
		).toBe("claude-opus-4-6");
	});

	it("maps an alias onto the catalog's canonical spelling", () => {
		const catalog = [{ value: "opus", tier: "flagship" as const }];
		expect(
			resolveModelForProviderCatalog("claude-opus-4-6", catalog, "anthropic"),
		).toBe("opus");
	});

	it("remaps an Anthropic preset onto the matching OpenAI tier (not Claude)", () => {
		// The whole point of the fix: choosing OpenAI must not surface Claude ids.
		const flagship = resolveModelForProviderCatalog("opus", openai, "openai");
		const standard = resolveModelForProviderCatalog("sonnet", openai, "openai");
		const fast = resolveModelForProviderCatalog("haiku", openai, "openai");

		expect(flagship.toLowerCase()).not.toContain("claude");
		expect(standard.toLowerCase()).not.toContain("claude");
		expect(fast.toLowerCase()).not.toContain("claude");

		expect(getModelTier(flagship)).toBe("flagship");
		expect(getModelTier(standard)).toBe("standard");
		expect(getModelTier(fast)).toBe("fast");
	});

	it("falls back to the flagship when the source tier is unknown", () => {
		const resolved = resolveModelForProviderCatalog(
			"some-unknown-model",
			openai,
			"openai",
		);
		expect(getModelTier(resolved)).toBe("flagship");
	});
});

describe("isModelForeignToProvider", () => {
	it("refuses a local tag to Claude, which only serves Claude models", () => {
		expect(isModelForeignToProvider("gemma4:12b-it-q4_K_M", "claude")).toBe(
			true,
		);
		expect(isModelForeignToProvider("qwen3:8b", "anthropic")).toBe(true);
		expect(isModelForeignToProvider("gpt-5.5", "claude")).toBe(true);
	});

	it("accepts every spelling Claude itself understands", () => {
		for (const model of [
			"claude-opus-4-8",
			"claude-sonnet-4-5-20250929",
			"claude-opus-4.8",
			"claude-opus-9-9",
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"opus",
			"sonnet[1m]",
			"opusplan",
		]) {
			expect(isModelForeignToProvider(model, "claude")).toBe(false);
		}
	});

	it("refuses an Anthropic-native id to another provider", () => {
		expect(isModelForeignToProvider("claude-opus-4-6", "openai")).toBe(true);
		expect(isModelForeignToProvider("claude-sonnet-4-6", "ollama")).toBe(true);
	});

	it("keeps what a provider may legitimately serve without the static catalogue knowing it", () => {
		// A tag pulled by hand, a gateway's dotted spelling, a fresh release.
		expect(isModelForeignToProvider("gemma4:12b-it-q4_K_M", "ollama")).toBe(
			false,
		);
		expect(isModelForeignToProvider("claude-opus-4.8", "copilot")).toBe(false);
		expect(isModelForeignToProvider("gpt-7-preview", "openai")).toBe(false);
		expect(isModelForeignToProvider("hf.co/org/model", "lm-studio")).toBe(
			false,
		);
	});

	it("has nothing to say without a model or a provider", () => {
		expect(isModelForeignToProvider("", "claude")).toBe(false);
		expect(isModelForeignToProvider("gemma4:12b", "")).toBe(false);
	});
});
