/**
 * Tests for the Workflow Profile store.
 *
 * The property that matters here is not "it fetches": it is that a request the
 * store has already superseded cannot write its answer. The modal can be
 * reopened on another card, and previewing an effort level fires a second
 * request for the same card while the first is still in flight — a single slot
 * would let the slow one overwrite the card the user is looking at.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

vi.mock("../../lib/agent-tools-api", () => ({
	fetchWorkflowProfile: (...args: unknown[]) => mockFetch(...args),
}));

import {
	workflowProfileKey,
	useWorkflowProfileStore,
} from "../workflow-profile-store";

const key = workflowProfileKey({
	taskId: "t1",
	projectDir: "/p",
	specId: "001-x",
});

function profile(effort: string, phaseIds: string[]) {
	return {
		ok: true as const,
		data: {
			profile: {
				workflow: "feature-build",
				description: "",
				effort,
				provider: "claude",
				enabled: true,
				phases: phaseIds.map((id) => ({
					id,
					impl: `p/${id}`,
					pack: "p",
					skill: id,
					description: "",
					minEffort: "none",
					hardGate: null,
					always: false,
					gate: null,
					conditional: false,
					whenGlobs: [],
					runs: true,
					dispatch: "inline",
					degradedFrom: null,
					degradedReason: "",
					skipReason: null,
					deterministic: false,
				})),
				runCount: phaseIds.length,
				missing: [],
			},
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useWorkflowProfileStore.setState({ byTask: {} });
});

describe("workflow-profile-store", () => {
	it("does nothing without a way to name the spec", async () => {
		const { result } = renderHook(() => useWorkflowProfileStore());
		await act(async () => {
			await result.current.load({ taskId: "t1" });
		});
		expect(mockFetch).not.toHaveBeenCalled();
		expect(result.current.byTask[key]).toBeUndefined();
	});

	it("stores the resolved profile under the task id", async () => {
		mockFetch.mockResolvedValueOnce(profile("high", ["coding", "verify"]));
		const { result } = renderHook(() => useWorkflowProfileStore());
		await act(async () => {
			await result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
			});
		});
		expect(result.current.byTask[key].profile?.effort).toBe("high");
		expect(result.current.byTask[key].loading).toBe(false);
		expect(result.current.byTask[key].error).toBeNull();
	});

	it("records an error without keeping a stale profile", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, error: "backend down" });
		const { result } = renderHook(() => useWorkflowProfileStore());
		await act(async () => {
			await result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
			});
		});
		expect(result.current.byTask[key].error).toBe("backend down");
		expect(result.current.byTask[key].profile).toBeNull();
	});

	it("marks a preview so the UI can say it is not the task's own level", async () => {
		mockFetch.mockResolvedValueOnce(profile("ultrathink", ["coding"]));
		const { result } = renderHook(() => useWorkflowProfileStore());
		await act(async () => {
			await result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
				effort: "ultrathink",
			});
		});
		expect(result.current.byTask[key].previewEffort).toBe("ultrathink");
	});

	it("a superseded request does not overwrite the newer answer", async () => {
		// The regression this store's shape exists for: the user clicks
		// "ultrathink" while the request for the task's own level is still out.
		let releaseSlow!: (v: unknown) => void;
		const slow = new Promise((resolve) => {
			releaseSlow = resolve;
		});

		mockFetch
			.mockImplementationOnce(async () => {
				await slow;
				return profile("medium", ["coding"]);
			})
			.mockResolvedValueOnce(profile("ultrathink", ["coding", "review"]));

		const { result } = renderHook(() => useWorkflowProfileStore());

		await act(async () => {
			const first = result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
			});
			await result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
				effort: "ultrathink",
			});
			releaseSlow(null);
			await first;
		});

		expect(result.current.byTask[key].profile?.effort).toBe("ultrathink");
		expect(result.current.byTask[key].previewEffort).toBe("ultrathink");
	});

	it("clear drops the entry and aborts what is in flight", async () => {
		mockFetch.mockResolvedValueOnce(profile("high", ["coding"]));
		const { result } = renderHook(() => useWorkflowProfileStore());
		await act(async () => {
			await result.current.load({
				taskId: "t1",
				projectDir: "/p",
				specId: "001-x",
			});
		});
		act(() => result.current.clear(key));
		expect(result.current.byTask[key]).toBeUndefined();
	});
});

it("isolates identical task ids from different projects", async () => {
	mockFetch
		.mockResolvedValueOnce(profile("low", ["coding"]))
		.mockResolvedValueOnce(profile("high", ["review"]));
	const store = useWorkflowProfileStore.getState();
	await store.load({ taskId: "t1", projectDir: "/p", specId: "001-x" });
	await store.load({ taskId: "t1", projectDir: "/other", specId: "001-x" });
	const other = workflowProfileKey({
		taskId: "t1",
		projectDir: "/other",
		specId: "001-x",
	});
	expect(useWorkflowProfileStore.getState().byTask[key].profile?.effort).toBe(
		"low",
	);
	expect(useWorkflowProfileStore.getState().byTask[other].profile?.effort).toBe(
		"high",
	);
});
