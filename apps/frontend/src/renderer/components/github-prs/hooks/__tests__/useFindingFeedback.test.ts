/**
 * @vitest-environment jsdom
 */
/**
 * The feedback state of one PR review (#361): loaded per PR, updated by each
 * answer of the main process, and quiet when that fails.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFindingFeedback } from "../useFindingFeedback";

const api = {
	getReviewFindingFeedback: vi.fn(),
	setReviewFindingFeedback: vi.fn(),
};

beforeEach(() => {
	api.getReviewFindingFeedback.mockReset();
	api.setReviewFindingFeedback.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = { github: api };
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const INPUT = { findingId: "f-1", verdict: "rejected" as const };

describe("useFindingFeedback", () => {
	it("does nothing without a project or a PR", async () => {
		const { result } = renderHook(() => useFindingFeedback(undefined, undefined));
		expect(api.getReviewFindingFeedback).not.toHaveBeenCalled();
		await act(async () => {
			expect(await result.current.submit(INPUT)).toBe(false);
		});
		expect(api.setReviewFindingFeedback).not.toHaveBeenCalled();
	});

	it("loads the PR's verdicts, then takes each answer", async () => {
		api.getReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { a: "accepted" },
		});
		api.setReviewFindingFeedback.mockResolvedValue({
			success: true,
			feedback: { a: "accepted", "f-1": "rejected" },
		});
		const { result } = renderHook(() => useFindingFeedback("p1", 3));
		await waitFor(() => expect(result.current.feedback).toEqual({ a: "accepted" }));
		await act(async () => {
			expect(await result.current.submit(INPUT)).toBe(true);
		});
		expect(api.setReviewFindingFeedback).toHaveBeenCalledWith("p1", 3, INPUT);
		expect(result.current.feedback["f-1"]).toBe("rejected");
		expect(result.current.error).toBeNull();
		expect(result.current.pendingId).toBeNull();
	});

	it("keeps the main process's refusal, and a failed call", async () => {
		api.getReviewFindingFeedback.mockResolvedValue({
			success: false,
			error: "server_project",
		});
		api.setReviewFindingFeedback
			.mockResolvedValueOnce({ success: false, error: "not_found" })
			.mockRejectedValueOnce(new Error("ipc down"));
		const { result } = renderHook(() => useFindingFeedback("p1", 3));
		await waitFor(() => expect(api.getReviewFindingFeedback).toHaveBeenCalled());
		expect(result.current.feedback).toEqual({});
		await act(async () => {
			expect(await result.current.submit(INPUT)).toBe(false);
		});
		expect(result.current.error).toBe("not_found");
		await act(async () => {
			expect(await result.current.submit(INPUT)).toBe(false);
		});
		expect(result.current.error).toBe("write_failed");
	});

	it("survives a failed load and ignores an answer that comes too late", async () => {
		api.getReviewFindingFeedback.mockRejectedValueOnce(new Error("ipc down"));
		const first = renderHook(() => useFindingFeedback("p1", 3));
		await waitFor(() => expect(api.getReviewFindingFeedback).toHaveBeenCalledTimes(1));
		expect(first.result.current.feedback).toEqual({});

		let resolve: (value: unknown) => void = () => undefined;
		api.getReviewFindingFeedback.mockReturnValueOnce(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const late = renderHook(() => useFindingFeedback("p1", 4));
		late.unmount();
		await act(async () => {
			resolve({ success: true, feedback: { x: "rejected" } });
		});
		expect(late.result.current.feedback).toEqual({});
	});
});
