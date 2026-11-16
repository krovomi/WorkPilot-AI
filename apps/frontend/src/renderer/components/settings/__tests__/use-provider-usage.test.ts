/**
 * @vitest-environment jsdom
 *
 * useProviderUsage — the usage the AI accounts page shows, per Claude account
 * and per other provider, live while the page is open: a Copilot snapshot
 * never lands on a Claude account.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { useProviderUsage } from "../use-provider-usage";

let api: RendererApi;
let onUsage: (snapshot: unknown) => void = () => undefined;
let onAll: (data: unknown) => void = () => undefined;

const snapshot = (extra: Record<string, unknown>) => ({
	profileId: "p1",
	profileName: "Me",
	sessionPercent: 50,
	weeklyPercent: 20,
	...extra,
});

function useApi(overrides: Record<string, unknown> = {}) {
	api = installRendererApi({
		requestAllProfilesUsage: vi.fn(async () => ({
			success: true,
			data: { allProfiles: [{ profileId: "p2", sessionPercent: 10, isActive: false }] },
		})),
		requestUsageUpdate: vi.fn(async (provider: string) =>
			provider === "copilot"
				? { success: true, data: snapshot({ profileId: "gh", providerName: "copilot", sessionPercent: 35 }) }
				: { success: true, data: snapshot({}) },
		),
		invoke: vi.fn(async (channel: string) =>
			channel === "usage:getAllData"
				? { windsurf: { usage: { sessionPercent: 12 } }, copilot: { usage: { sessionPercent: 99 } }, empty: {} }
				: undefined,
		),
		onUsageUpdated: vi.fn((listener) => {
			onUsage = listener;
			return () => undefined;
		}),
		onAllProfilesUsageUpdated: vi.fn((listener) => {
			onAll = listener;
			return () => undefined;
		}),
		...overrides,
	});
}

afterEach(() => {
	api.restore();
	vi.restoreAllMocks();
});

describe("useProviderUsage", () => {
	it("reads every account's usage, the live one over the cached one", async () => {
		useApi();
		const { result } = renderHook(() => useProviderUsage(true));
		await waitFor(() => expect(result.current.providerUsage.get("windsurf")).toEqual({ sessionPercent: 12 }));
		expect(result.current.claudeUsage.get("p1")).toMatchObject({ sessionPercent: 50, isActive: true, availabilityScore: 50 });
		expect(result.current.claudeUsage.get("p2")).toMatchObject({ sessionPercent: 10 });
		expect(result.current.providerUsage.get("copilot")).toMatchObject({ sessionPercent: 35 });
		expect(result.current.claudeUsage.has("gh")).toBe(false);
	});

	it("follows the live snapshots, skipping the active account's lagging cache", async () => {
		useApi();
		const { result } = renderHook(() => useProviderUsage(true));
		await waitFor(() => expect(result.current.claudeUsage.get("p1")).toBeDefined());
		act(() => onUsage(snapshot({ sessionPercent: 70 })));
		act(() => onUsage(null));
		act(() => onUsage({ providerName: "copilot" }));
		act(() =>
			onAll({
				allProfiles: [
					{ profileId: "p1", sessionPercent: 1, isActive: true },
					{ profileId: "p3", sessionPercent: 5, isActive: false },
				],
			}),
		);
		expect(result.current.claudeUsage.get("p1")?.sessionPercent).toBe(70);
		expect(result.current.claudeUsage.get("p3")?.sessionPercent).toBe(5);
	});

	it("does nothing while the page is closed", () => {
		useApi();
		renderHook(() => useProviderUsage(false));
		expect(api.fn("requestAllProfilesUsage")).not.toHaveBeenCalled();
	});

	it("keeps going when a read fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		useApi({
			requestAllProfilesUsage: vi.fn(async () => Promise.reject(new Error("a"))),
			requestUsageUpdate: vi.fn(async () => Promise.reject(new Error("b"))),
			invoke: vi.fn(async () => Promise.reject(new Error("c"))),
		});
		renderHook(() => useProviderUsage(true));
		await waitFor(() => expect(warn).toHaveBeenCalledTimes(4));
	});

	it("ignores answers that come after it closed, and unanswered reads", async () => {
		useApi({
			requestAllProfilesUsage: vi.fn(async () => ({ success: false })),
			requestUsageUpdate: vi.fn(async () => ({ success: false })),
			invoke: vi.fn(async () => undefined),
		});
		const first = renderHook(() => useProviderUsage(true));
		await waitFor(() => expect(api.fn("invoke")).toHaveBeenCalledWith("usage:getAllData"));
		expect(first.result.current.claudeUsage.size).toBe(0);
		first.unmount();

		api.restore();
		useApi();
		const second = renderHook(() => useProviderUsage(true));
		second.unmount();
		await act(async () => undefined);
		expect(second.result.current.claudeUsage.size).toBe(0);
	});
});
