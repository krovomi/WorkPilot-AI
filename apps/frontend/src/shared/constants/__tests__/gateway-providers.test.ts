import { describe, expect, it } from "vitest";
import { detectProvider, getProviderBadgeColor, getProviderLabel } from "../../utils/provider-detection";
import {
	GATEWAY_PROVIDER_IDS,
	GATEWAY_PROVIDERS,
	gatewayMap,
	gatewayProvider,
	isGatewayProvider,
} from "../gateway-providers";

describe("model gateways", () => {
	it("lists OpenRouter and Hugging Face with the backend's endpoints", () => {
		expect(GATEWAY_PROVIDER_IDS).toEqual(["openrouter", "huggingface"]);
		expect(gatewayProvider("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
		expect(gatewayProvider("huggingface")?.baseUrl).toBe("https://router.huggingface.co/v1");
		expect(gatewayProvider("mistral")).toBeUndefined();
	});

	it("checks a key on an https account endpoint of the gateway itself", () => {
		for (const gateway of GATEWAY_PROVIDERS) {
			const url = new URL(gateway.keyCheckUrl);
			expect(url.protocol).toBe("https:");
			expect(gateway.domainPatterns.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`))).toBe(true);
		}
	});

	it("tells a gateway id from any other", () => {
		expect(isGatewayProvider("huggingface")).toBe(true);
		expect(isGatewayProvider("deepseek")).toBe(false);
		expect(isGatewayProvider(undefined)).toBe(false);
		expect(gatewayMap((g) => g.envVar)).toEqual({
			openrouter: "OPENROUTER_API_KEY",
			huggingface: "HUGGINGFACE_API_KEY",
		});
	});

	it("reads a profile URL on either gateway as that gateway", () => {
		expect(detectProvider("https://openrouter.ai/api")).toBe("openrouter");
		expect(detectProvider("https://router.huggingface.co/v1")).toBe("huggingface");
		expect(detectProvider("https://openrouter.ai.evil.example/api")).toBe("unknown");
		expect(getProviderLabel("openrouter")).toBe("OpenRouter");
		expect(getProviderLabel("huggingface")).toBe("Hugging Face");
		expect(getProviderBadgeColor("openrouter")).toContain("indigo");
		expect(getProviderBadgeColor("huggingface")).toContain("yellow");
	});
});
