import { describe, expect, it } from "vitest";
import { getModelPricing, isPerTokenBilled } from "./model-pricing";

const resolved = (provider: string, model: string) =>
	getModelPricing(provider, model)?.model ?? null;

describe("getModelPricing", () => {
	it("prices a model by its own row, not by an older or smaller one", () => {
		// Each resolved to gpt-5's or gpt-4.1's row with the old two-way match.
		expect(getModelPricing("openai", "gpt-5.5")).toMatchObject({
			model: "gpt-5.5",
			input: 5,
			output: 30,
		});
		expect(resolved("openai", "gpt-4.1-mini")).toBe("gpt-4.1-mini");
		expect(resolved("openai", "gpt-4")).toBe("gpt-4");
		expect(resolved("anthropic", "claude-opus-5-5")).toBe("claude-opus-5-5");
	});

	it("resolves a snapshot or release tag to its model", () => {
		expect(resolved("anthropic", "claude-opus-4-5-20251101")).toBe(
			"claude-opus-4-5-20251101",
		);
		expect(resolved("openai", "gpt-5.5-2026-04-23")).toBe("gpt-5.5");
		expect(resolved("google", "gemini-3.1-pro-preview")).toBe("gemini-3.1-pro");
		expect(resolved("grok", "grok-4.20-0309-non-reasoning")).toBe("grok-4.20");
		expect(resolved("aws", "anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"anthropic.claude-sonnet-4-5",
		);
		expect(resolved("anthropic", "claude-sonnet-4-6[1m]")).toBe(
			"claude-sonnet-4-6",
		);
	});

	it("leaves an unknown version or variant unpriced", () => {
		expect(getModelPricing("openai", "gpt-5.5-mini")).toBeNull();
		expect(getModelPricing("openai", "gpt-5.9")).toBeNull();
		expect(getModelPricing("anthropic", "claude-opus-5-7")).toBeNull();
		expect(getModelPricing("anthropic", "claude")).toBeNull();
		expect(getModelPricing("unknown", "model")).toBeNull();
		expect(getModelPricing("openai", "")).toBeNull();
	});

	it("resolves Claude shorthand aliases and the claude provider name", () => {
		expect(resolved("claude", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
		expect(resolved("anthropic", "opus-5")).toBe("claude-opus-5");
	});

	it("treats every model of a flat-rate provider as $0 a token", () => {
		expect(getModelPricing("copilot", "claude-opus-4.8")).toMatchObject({
			input: 0,
			output: 0,
		});
		expect(isPerTokenBilled("ollama", "qwen3-coder:30b")).toBe(false);
		expect(isPerTokenBilled("openai", "gpt-5.5")).toBe(true);
	});
});
