import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProviderModelCatalog } from "./useProviderModelCatalog";
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("does not retain previous-provider live models while the new catalog loads", async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce({
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({
				models: [{ value: "old-local-model", label: "Old local" }],
				source: "live",
			}),
		})
		.mockImplementation(
			() =>
				new Promise(() => {
					/* Keep the next provider request pending. */
				}),
		);
	vi.stubGlobal("fetch", fetchMock);
	const { result, rerender } = renderHook(
		({ provider }) => useProviderModelCatalog(provider),
		{ initialProps: { provider: "test-old-provider" } },
	);
	await waitFor(() =>
		expect(
			result.current.models.some((m) => m.value === "old-local-model"),
		).toBe(true),
	);
	act(() => rerender({ provider: "test-new-provider" }));
	expect(result.current.models.some((m) => m.value === "old-local-model")).toBe(
		false,
	);
});

it("shares discovery and refresh between all mounted selectors", async () => {
	const response = (value: string) => ({
		ok: true,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({ models: [{ value, label: value }], source: "live" }),
	});
	const fetchMock = vi.fn().mockResolvedValue(response("gemma4:12b-it-q4_K_M"));
	vi.stubGlobal("fetch", fetchMock);
	const { result } = renderHook(() => ({
		phase: useProviderModelCatalog("ollama"),
		resume: useProviderModelCatalog("local"),
	}));
	await waitFor(() =>
		expect(
			result.current.phase.models.some(
				(m) => m.value === "gemma4:12b-it-q4_K_M",
			),
		).toBe(true),
	);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(result.current.resume.models).toBe(result.current.phase.models);
	fetchMock.mockResolvedValue(response("newly-downloaded-model"));
	act(() => result.current.resume.refresh());
	await waitFor(() =>
		expect(
			result.current.phase.models.some(
				(m) => m.value === "newly-downloaded-model",
			),
		).toBe(true),
	);
	expect(result.current.resume.models).toBe(result.current.phase.models);
});

it("automatically discovers models added while a selector stays open", async () => {
	vi.useFakeTimers();
	const response = (value: string) => ({
		ok: true,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({ source: "live", models: [{ value, label: value }] }),
	});
	const fetchMock = vi.fn().mockResolvedValue(response("first-model"));
	vi.stubGlobal("fetch", fetchMock);
	const { result, unmount } = renderHook(() =>
		useProviderModelCatalog("lm-studio"),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(result.current.models.some((m) => m.value === "first-model")).toBe(
		true,
	);
	fetchMock.mockResolvedValue(response("installed-later"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
	expect(result.current.models.some((m) => m.value === "installed-later")).toBe(
		true,
	);
	expect(result.current.models.some((m) => m.value === "first-model")).toBe(
		false,
	);
	unmount();
	vi.useRealTimers();
});

it("does not mark static suggestions as installed when the runtime is empty", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ source: "live", models: [] }),
		}),
	);
	const { result } = renderHook(() => useProviderModelCatalog("local"));
	act(() => result.current.refresh());
	await waitFor(() => expect(result.current.loading).toBe(false));
	expect(result.current.models.every((m) => m.installed === false)).toBe(true);
});
