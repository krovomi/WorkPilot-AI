/**
 * Provider connection tests run in main, which holds the keys (rule S6): the
 * renderer only sees them masked, so ProviderService never calls a provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderService } from "../providerService";

describe("ProviderService.testProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(globalThis, "electronAPI");
	});

	it("asks main and never calls the provider itself", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const invoke = vi.fn().mockResolvedValue({ success: true, message: "ok" });
		Object.assign(globalThis, { electronAPI: { invoke } });

		expect(await ProviderService.testProvider("openai")).toEqual({
			success: true,
			message: "ok",
		});
		expect(invoke).toHaveBeenCalledWith("credential:testProvider", "openai");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports a failure, still without calling the provider", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		Object.assign(globalThis, {
			electronAPI: { invoke: vi.fn().mockRejectedValue(new Error("boom")) },
		});

		expect(await ProviderService.testProvider("mistral")).toEqual({
			success: false,
			message: "boom",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
