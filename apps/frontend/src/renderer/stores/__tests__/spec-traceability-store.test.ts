/**
 * Tests for the Spec Traceability store.
 *
 * Same property as the workflow-profile store, for the same reason: the modal
 * can be reopened on another card while the first request is still in flight,
 * and a single slot would let the slow answer paint the card the user is no
 * longer looking at.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

vi.mock("../../lib/agent-tools-api", () => ({
	fetchSpecTraceability: (...args: unknown[]) => mockFetch(...args),
}));

import { useSpecTraceabilityStore } from "../spec-traceability-store";

function payload(spec: string, uncovered: string[]) {
	return {
		ok: true as const,
		data: {
			spec,
			requirements: [{ id: "FR-001", title: "One", line: 3 }],
			openQuestions: [{ question: "which?", section: "Requirements", line: 3 }],
			coverage: {
				applicable: true,
				reason: "",
				percent: 50,
				covered: { "FR-001": ["subtask-1-1"] },
				uncovered,
				unknownRefs: {},
				summary: "1/2",
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useSpecTraceabilityStore.setState({ byTask: {} });
});

describe("spec-traceability-store", () => {
	it("does nothing without a way to name the spec", async () => {
		const { result } = renderHook(() => useSpecTraceabilityStore());
		await act(async () => {
			await result.current.load({ taskId: "t1" });
		});
		expect(mockFetch).not.toHaveBeenCalled();
		expect(result.current.byTask.t1).toBeUndefined();
	});

	it("keeps each task's answer under its own key", async () => {
		mockFetch
			.mockResolvedValueOnce(payload("001-a", ["FR-002"]))
			.mockResolvedValueOnce(payload("002-b", []));

		const { result } = renderHook(() => useSpecTraceabilityStore());
		await act(async () => {
			await result.current.load({ taskId: "t1", specDir: "/a" });
			await result.current.load({ taskId: "t2", specDir: "/b" });
		});

		expect(result.current.byTask.t1?.traceability?.spec).toBe("001-a");
		expect(result.current.byTask.t2?.traceability?.spec).toBe("002-b");
	});

	it("drops the answer of a request it has already superseded", async () => {
		// Replaced synchronously by the promise below; never called as-is.
		let releaseFirst: (value: unknown) => void = () => undefined;
		mockFetch
			.mockReturnValueOnce(
				new Promise((resolve) => {
					releaseFirst = resolve;
				}),
			)
			.mockResolvedValueOnce(payload("second", []));

		const { result } = renderHook(() => useSpecTraceabilityStore());
		await act(async () => {
			const slow = result.current.load({ taskId: "t1", specDir: "/a" });
			await result.current.load({ taskId: "t1", specDir: "/b" });
			releaseFirst(payload("first", ["FR-009"]));
			await slow;
		});

		expect(result.current.byTask.t1?.traceability?.spec).toBe("second");
	});

	it("an aborted request leaves the card as it was", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, error: "aborted" });

		const { result } = renderHook(() => useSpecTraceabilityStore());
		await act(async () => {
			await result.current.load({ taskId: "t1", specDir: "/a" });
		});

		expect(result.current.byTask.t1?.error).toBeNull();
		expect(result.current.byTask.t1?.traceability).toBeNull();
	});

	it("clearing a task aborts its request and forgets it", async () => {
		mockFetch.mockResolvedValueOnce(payload("001-a", []));

		const { result } = renderHook(() => useSpecTraceabilityStore());
		await act(async () => {
			await result.current.load({ taskId: "t1", specDir: "/a" });
			result.current.clear("t1");
		});

		expect(result.current.byTask.t1).toBeUndefined();
	});
});
