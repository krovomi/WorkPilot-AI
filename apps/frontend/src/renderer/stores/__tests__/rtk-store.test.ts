/**
 * Tests for the rtk store.
 *
 * Two properties, and neither is "it fetches".
 *
 * The first is that "not here" is an answer rather than an error: on a server
 * deployment the backend refuses this endpoint by design, and a red message
 * about it on every task panel open would be noise about a decision nobody
 * can act on.
 *
 * The second is that switching project re-reads. The status is about a binary
 * on the machine *and* a ledger scoped to one project, so caching it across a
 * project switch would report the previous project's savings under the new
 * one's name.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

vi.mock("../../lib/agent-tools-api", () => ({
	fetchRtkStatus: (...args: unknown[]) => mockFetch(...args),
}));

import { useRtkStore } from "../rtk-store";

function status(installed: boolean, commands = 0) {
	return {
		ok: true as const,
		data: {
			status: {
				readiness: {
					installed,
					enabled: true,
					version: installed ? "0.48.0" : "",
					binary: installed ? "/usr/local/bin/rtk" : "",
					state: installed ? "active" : "absent",
					checks: [],
				},
				savings: {
					available: installed,
					commands,
					inputBytes: 0,
					outputBytes: 0,
					savedBytes: 0,
					savedTokens: 0,
					averagePct: 0,
					reason: "",
				},
			},
		},
	};
}

describe("rtk store", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		useRtkStore.getState().reset();
	});

	it("loads the status once and keeps it", async () => {
		mockFetch.mockResolvedValue(status(true));
		const { result } = renderHook(() => useRtkStore());

		await act(async () => {
			await result.current.load("/p");
			await result.current.load("/p");
		});

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(result.current.status?.readiness.installed).toBe(true);
	});

	it("re-reads when the project changes", async () => {
		mockFetch.mockResolvedValue(status(true));
		const { result } = renderHook(() => useRtkStore());

		await act(async () => {
			await result.current.load("/one");
			await result.current.load("/two");
		});

		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("reloads on demand, because savings move", async () => {
		mockFetch.mockResolvedValueOnce(status(true, 0));
		mockFetch.mockResolvedValueOnce(status(true, 12));
		const { result } = renderHook(() => useRtkStore());

		await act(async () => {
			await result.current.load("/p");
			await result.current.load("/p", true);
		});

		expect(result.current.status?.savings.commands).toBe(12);
	});

	it("treats the server-mode refusal as an answer, not an error", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			error: "rtk status is a desktop feature",
		});
		const { result } = renderHook(() => useRtkStore());

		await act(async () => {
			await result.current.load("/p");
		});

		expect(result.current.unavailable).toBe(true);
		expect(result.current.error).toBeNull();
	});

	it("surfaces a real failure", async () => {
		mockFetch.mockResolvedValue({ ok: false, error: "backend unreachable" });
		const { result } = renderHook(() => useRtkStore());

		await act(async () => {
			await result.current.load("/p");
		});

		expect(result.current.unavailable).toBe(false);
		expect(result.current.error).toBe("backend unreachable");
	});
});
