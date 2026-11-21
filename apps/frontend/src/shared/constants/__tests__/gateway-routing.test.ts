import { describe, expect, it } from "vitest";
import {
	cleanFallbackModels,
	gatewayRoutingEnv,
	isGatewayModelId,
	MAX_FALLBACK_MODELS,
} from "../gateway-routing";

describe("gateway routing", () => {
	it("hands OpenRouter its fallbacks, order and privacy filters", () => {
		expect(
			gatewayRoutingEnv("openrouter", {
				openRouterFallbackModels: [" z-ai/glm-5.3 ", "deepseek/v4@2026"],
				openRouterSort: "throughput",
				openRouterDenyDataCollection: true,
				openRouterZeroRetention: true,
			}),
		).toEqual({
			OPENROUTER_FALLBACK_MODELS: "z-ai/glm-5.3,deepseek/v4@2026",
			OPENROUTER_PROVIDER_SORT: "throughput",
			OPENROUTER_DATA_COLLECTION: "deny",
			OPENROUTER_ZDR: "1",
		});
	});

	it("hands Hugging Face its router policy only", () => {
		const settings = { huggingFaceRoutingPolicy: "cheapest", openRouterSort: "price" } as const;
		expect(gatewayRoutingEnv("huggingface", settings)).toEqual({
			HUGGINGFACE_ROUTING_POLICY: "cheapest",
		});
		expect(gatewayRoutingEnv("mistral", settings)).toEqual({});
	});

	it("sends nothing for a default, a cleared or a forged value", () => {
		expect(gatewayRoutingEnv("openrouter", undefined)).toEqual({});
		expect(gatewayRoutingEnv("openrouter", { openRouterSort: "" })).toEqual({});
		expect(
			gatewayRoutingEnv("openrouter", {
				openRouterSort: "random" as never,
				openRouterDenyDataCollection: "yes" as never,
				openRouterFallbackModels: ["a/b c", "../x", "https://evil.test/x", 4 as never],
			}),
		).toEqual({});
		expect(gatewayRoutingEnv("huggingface", { huggingFaceRoutingPolicy: "" })).toEqual({});
	});

	it("keeps valid fallbacks once, at most the limit", () => {
		const many = Array.from({ length: MAX_FALLBACK_MODELS + 2 }, (_, i) => `v/m${i}`);
		expect(cleanFallbackModels(["v/m0", ...many])).toEqual(many.slice(0, MAX_FALLBACK_MODELS));
		expect(cleanFallbackModels(undefined)).toEqual([]);
	});

	it("recognises a gateway model id", () => {
		for (const id of ["moonshotai/kimi-k3.1-pro", "openai/gpt-5.5:online", "x/y@2026-01"]) {
			expect(isGatewayModelId(id)).toBe(true);
		}
		for (const id of ["kimi", "/x", "a/", "a b/c", "a/b;rm", `a/${"x".repeat(200)}`]) {
			expect(isGatewayModelId(id)).toBe(false);
		}
	});
});
