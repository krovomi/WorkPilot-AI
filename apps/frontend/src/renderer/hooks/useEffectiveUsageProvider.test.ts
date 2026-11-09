import { describe, expect, it } from "vitest";
import { resolveUsageProvider } from "./useEffectiveUsageProvider";

describe("resolveUsageProvider", () => {
	it("keeps the provider the context resolved", () => {
		expect(resolveUsageProvider("openai", true, undefined)).toBe("openai");
	});

	it("waits while settings are being read", () => {
		expect(resolveUsageProvider("", false, undefined)).toBe("");
	});

	it("falls back to Anthropic on a first start, where nothing picked one", () => {
		// An empty provider kept the usage badge on "Loading..." for good.
		expect(resolveUsageProvider("", true, undefined)).toBe("anthropic");
	});

	it("follows the active API profile when there is one", () => {
		expect(resolveUsageProvider("", true, "https://api.openai.com/v1")).toBe("openai");
	});
});
