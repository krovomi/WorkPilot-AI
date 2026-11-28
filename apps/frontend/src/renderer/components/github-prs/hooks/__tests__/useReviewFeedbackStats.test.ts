/**
 * @vitest-environment jsdom
 */
/**
 * The project-wide feedback state (#361, lot 2): loaded on demand, updated by
 * each answer of the main process, an answer for a project the view left is
 * dropped, and a failure is said.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewFeedbackStats } from "../useReviewFeedbackStats";

const api = {
	getReviewFeedbackStats: vi.fn(),
	resetReviewFeedbackRule: vi.fn(),
	writeReviewConventions: vi.fn(),
};

const STATS = {
	threshold: 3,
	categories: [{ category: "style", accepted: 1, rejected: 3, notApplicable: 0 }],
	rules: [],
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { github: api };
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useReviewFeedbackStats", () => {
	it("does nothing without a project", async () => {
		const { result } = renderHook(() => useReviewFeedbackStats(undefined));
		await act(async () => {
			await result.current.load();
			await result.current.reset("0123456789abcdef");
			await result.current.writeConventions();
		});
		for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
	});

	it("loads, then says a refusal", async () => {
		api.getReviewFeedbackStats
			.mockResolvedValueOnce({ success: true, stats: STATS })
			.mockResolvedValueOnce({ success: false, error: "server_project" });
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.load());
		expect(result.current.stats).toEqual(STATS);
		expect(result.current.error).toBeNull();
		expect(result.current.loading).toBe(false);
		await act(() => result.current.load());
		expect(result.current.error).toBe("server_project");
	});

	it("says a load that throws", async () => {
		api.getReviewFeedbackStats.mockRejectedValue(new Error("ipc down"));
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.load());
		expect(result.current.error).toBe("not_found");
	});

	it("resets a rule and takes the new stats", async () => {
		api.resetReviewFeedbackRule.mockResolvedValue({ success: true, stats: STATS });
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.reset("0123456789abcdef"));
		expect(api.resetReviewFeedbackRule).toHaveBeenCalledWith(
			"p1",
			"0123456789abcdef",
		);
		expect(result.current.stats).toEqual(STATS);
		expect(result.current.pendingSignature).toBeNull();
	});

	it("says a reset that throws", async () => {
		api.resetReviewFeedbackRule.mockRejectedValue(new Error("ipc down"));
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.reset("0123456789abcdef"));
		expect(result.current.error).toBe("write_failed");
	});

	it("writes the conventions file, then says a refusal and a throw", async () => {
		api.writeReviewConventions
			.mockResolvedValueOnce({
				success: true,
				path: ".workpilot/review-conventions.md",
				rules: 2,
			})
			.mockResolvedValueOnce({ success: false, error: "write_failed" })
			.mockRejectedValueOnce(new Error("ipc down"));
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.writeConventions());
		expect(result.current.written).toEqual({
			path: ".workpilot/review-conventions.md",
			rules: 2,
		});
		await act(() => result.current.writeConventions());
		expect(result.current.written).toBeNull();
		expect(result.current.error).toBe("write_failed");
		api.writeReviewConventions.mockClear();
		await act(() => result.current.writeConventions());
		expect(result.current.error).toBe("write_failed");
		expect(result.current.writing).toBe(false);
	});

	it("says nothing when the save dialog is closed", async () => {
		api.writeReviewConventions.mockResolvedValueOnce({
			success: false,
			error: "cancelled",
		});
		const { result } = renderHook(() => useReviewFeedbackStats("p1"));
		await act(() => result.current.writeConventions());
		expect(result.current.error).toBeNull();
		expect(result.current.written).toBeNull();
		expect(result.current.writing).toBe(false);
	});

	it("drops an answer for a project the view has left", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.getReviewFeedbackStats.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const { result, rerender } = renderHook(
			({ id }) => useReviewFeedbackStats(id),
			{ initialProps: { id: "p1" } },
		);
		let pending: Promise<void> = Promise.resolve();
		act(() => {
			pending = result.current.load();
		});
		rerender({ id: "p2" });
		await act(async () => {
			answer({ success: true, stats: STATS });
			await pending;
		});
		expect(result.current.stats).toBeNull();
	});
});
