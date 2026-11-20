/**
 * The Arena's roster, and the capability matrix it reads: every model of
 * every configured provider that drives its own models, the providers left
 * out and why, a refresh that asks the providers again, and the matrix read
 * under whatever spelling the UI gives a provider.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getStaticProviders = vi.hoisted(() => vi.fn());
const fetchProviderModelCatalog = vi.hoisted(() => vi.fn());
const localBackendFetch = vi.hoisted(() => vi.fn());
vi.mock("@shared/utils/providers", () => ({ getStaticProviders }));
vi.mock("../useProviderModelCatalog", () => ({ fetchProviderModelCatalog }));
vi.mock("../../lib/local-backend", () => ({ localBackendFetch }));

import { useSettingsStore } from "@/stores/settings-store";
import { fetchAgenticCapabilities, useAgenticCapabilities } from "../useAgenticCapabilities";
import { useArenaContenders } from "../useArenaContenders";

const provider = (name: string) => ({ name, label: name.toUpperCase() });
const model = (value: string, extra: object = {}) => ({ value, label: `${value}!`, ...extra });
const matrix = (providers: object) => ({ ok: true, json: async () => ({ providers }) });

beforeEach(() => {
	getStaticProviders.mockReset().mockResolvedValue({
		providers: [provider("anthropic"), provider("openai"), provider("lm-studio"), provider("mistral"), provider("gemini")],
		status: { anthropic: true, openai: true, "lm-studio": true, mistral: true, gemini: false },
	});
	fetchProviderModelCatalog.mockReset().mockImplementation(async (name: string) => {
		if (name === "anthropic") return { models: [model("opus"), model("opus")], source: "live" };
		if (name === "openai") return { models: [model("gpt")], source: "registry", error: "401" };
		return { models: [], source: "registry", error: name === "mistral" ? "timeout" : undefined };
	});
	localBackendFetch.mockReset().mockResolvedValue(matrix({ lmstudio: { hasAdapter: false, degradesTo: null }, claude: { hasAdapter: true } }));
});

describe("the roster", () => {
	it("lists each model of each configured provider once", async () => {
		const { result } = renderHook(() => useArenaContenders());
		expect(result.current).toMatchObject({ loading: true, loaded: false });
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.contenders.map((c) => [c.id, c.modelLabel, c.source])).toEqual([
			["anthropic:opus", "opus!", "live"],
			["openai:gpt", "gpt!", "registry"],
		]);
		expect(result.current.providers).toEqual([
			{ name: "anthropic", label: "ANTHROPIC", count: 1 },
			{ name: "openai", label: "OPENAI", count: 1 },
		]);
		expect(result.current.loading).toBe(false);
	});

	it("leaves out a provider with no adapter of its own, under the matrix's spelling of its name", async () => {
		const { result } = renderHook(() => useArenaContenders());
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.degrading).toEqual([{ name: "lm-studio", label: "LM-STUDIO", degradesTo: "claude" }]);
		expect(fetchProviderModelCatalog).not.toHaveBeenCalledWith("lm-studio", expect.anything());
	});

	it("reports a configured provider that produced nobody, with the reason", async () => {
		const { result } = renderHook(() => useArenaContenders());
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.unreachable).toEqual([{ name: "mistral", label: "MISTRAL", error: "timeout" }]);

		fetchProviderModelCatalog.mockImplementation(async () => ({ models: [], source: "registry" }));
		act(() => result.current.refresh());
		await waitFor(() => expect(result.current.unreachable.map((p) => p.error)).toEqual(["no-models", "no-models", "no-models"]));
	});

	it("asks the providers again only when the person refreshes", async () => {
		const { result, rerender } = renderHook(() => useArenaContenders());
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(fetchProviderModelCatalog).toHaveBeenCalledWith("anthropic", false);

		act(() => useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings } }));
		rerender();
		await waitFor(() => expect(fetchProviderModelCatalog).toHaveBeenCalledTimes(6));
		expect(fetchProviderModelCatalog).not.toHaveBeenCalledWith("anthropic", true);

		act(() => result.current.refresh());
		await waitFor(() => expect(fetchProviderModelCatalog).toHaveBeenCalledWith("anthropic", true));
	});

	it("ends loaded, and keeps what it had, when the providers cannot be read", async () => {
		getStaticProviders.mockRejectedValueOnce(new Error("ipc closed"));
		const { result } = renderHook(() => useArenaContenders());
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current).toMatchObject({ contenders: [], loading: false });
	});

	it("drops a roster, or a failure, that arrives after the page closed", async () => {
		let answer: (value: unknown) => void = vi.fn();
		getStaticProviders.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const first = renderHook(() => useArenaContenders());
		first.unmount();
		await act(async () => answer({ providers: [provider("openai")], status: { openai: true } }));
		expect(first.result.current.loaded).toBe(false);

		let catalog: (value: unknown) => void = vi.fn();
		fetchProviderModelCatalog.mockReturnValueOnce(new Promise((resolve) => (catalog = resolve)));
		getStaticProviders.mockResolvedValueOnce({ providers: [provider("openai")], status: { openai: true } });
		const second = renderHook(() => useArenaContenders());
		await waitFor(() => expect(fetchProviderModelCatalog).toHaveBeenCalled());
		second.unmount();
		await act(async () => catalog({ models: [model("gpt")], source: "live" }));
		expect(second.result.current.contenders).toEqual([]);

		let fail: (reason: unknown) => void = vi.fn();
		getStaticProviders.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
		const third = renderHook(() => useArenaContenders());
		third.unmount();
		await act(async () => fail(new Error("late")));
		expect(third.result.current.loaded).toBe(false);
	});
});

describe("the capability matrix", () => {
	it("is read from the backend, and empty when it cannot be", async () => {
		expect(await fetchAgenticCapabilities()).toMatchObject({ lmstudio: { hasAdapter: false } });
		localBackendFetch.mockResolvedValueOnce({ ok: false });
		expect(await fetchAgenticCapabilities()).toEqual({});
		localBackendFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
		expect(await fetchAgenticCapabilities()).toEqual({});
		localBackendFetch.mockRejectedValueOnce(new Error("backend starting"));
		expect(await fetchAgenticCapabilities()).toEqual({});
	});

	it("answers for a provider under every spelling of its name", async () => {
		localBackendFetch.mockResolvedValueOnce(
			matrix({
				claude: { hasAdapter: true, contextCompact: "native", contextUsage: "exact" },
				lmstudio: { hasAdapter: false, degradesTo: "openai", contextCompact: "emulated", contextUsage: "estimated" },
				local: { hasAdapter: false, degradesTo: null, contextCompact: "other", contextUsage: "reported" },
				openai: { hasAdapter: true, contextUsage: "guessed" },
			}),
		);
		const { result } = renderHook(() => useAgenticCapabilities());
		expect(result.current.loaded).toBe(false);
		await waitFor(() => expect(result.current.loaded).toBe(true));
		const c = result.current;
		expect([c.hasAdapter(" Anthropic "), c.hasAdapter("LM-Studio"), c.hasAdapter("llama-cpp"), c.hasAdapter("unknown")]).toEqual([true, false, false, true]);
		expect([c.degradesTo("anthropic"), c.degradesTo("lm-studio"), c.degradesTo("llama-cpp"), c.degradesTo("unknown")]).toEqual([null, "openai", "claude", null]);
		expect([c.contextCompact("anthropic"), c.contextCompact("lm-studio"), c.contextCompact("llama-cpp")]).toEqual(["native", "emulated", null]);
		expect([c.contextUsage("anthropic"), c.contextUsage("lm-studio"), c.contextUsage("llama-cpp"), c.contextUsage("openai"), c.contextUsage("")]).toEqual(["exact", "estimated", "reported", null, null]);
	});

	it("drops a matrix that arrives after the page closed", async () => {
		let answer: (value: unknown) => void = vi.fn();
		localBackendFetch.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const { result, unmount } = renderHook(() => useAgenticCapabilities());
		unmount();
		await act(async () => answer(matrix({ claude: { hasAdapter: false } })));
		expect(result.current.loaded).toBe(false);
	});
});
