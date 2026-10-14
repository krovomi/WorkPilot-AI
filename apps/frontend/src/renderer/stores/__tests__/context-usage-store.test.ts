/**
 * Context-window telemetry store: the last usage per task, a capped history of
 * applied actions, and the one listener registered by global-listeners.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("../../hooks/use-toast", () => ({
	toast: (...args: unknown[]) => toastMock(...args),
}));

import {
	CONTEXT_HISTORY_LIMIT,
	handleContextEvent,
	isContextActiveStatus,
	setupContextUsageListeners,
	useContextUsageStore,
} from "../context-usage-store";

const usage = (percent: number) => ({
	type: "CONTEXT_USAGE",
	phase: "coding",
	subtaskId: null,
	provider: "claude",
	model: "claude-sonnet",
	usedTokens: percent * 2000,
	windowTokens: 200_000,
	percent,
	source: "estimated",
	thresholdPct: 50,
	mode: "auto",
	handoffState: "preparing",
	recommended: "compact",
	compactSupport: "native",
});

const applied = (eventId: string, beforePct = 62, afterPct: number | null = 18) => ({
	type: "CONTEXT_ACTION_APPLIED",
	eventId,
	action: "compact",
	trigger: "auto",
	phase: "coding",
	subtaskId: null,
	provider: "claude",
	native: true,
	beforePct,
	afterPct,
});

beforeEach(() => {
	useContextUsageStore.getState().reset();
	toastMock.mockReset();
});

describe("context-usage-store", () => {
	it("keeps the last usage of each task", () => {
		handleContextEvent("t1", usage(30));
		handleContextEvent("t1", usage(41));
		handleContextEvent("t2", usage(10));
		const state = useContextUsageStore.getState();
		expect(state.usage.t1.percent).toBe(41);
		expect(state.usage.t2.percent).toBe(10);
	});

	it("records applied actions newest first, capped, deduplicated, and toasts them", () => {
		handleContextEvent("t1", usage(62));
		for (let i = 0; i < CONTEXT_HISTORY_LIMIT + 3; i++) {
			handleContextEvent("t1", applied(`e${i}`));
		}
		const toasts = toastMock.mock.calls.length;
		handleContextEvent("t1", applied(`e${CONTEXT_HISTORY_LIMIT + 2}`));
		expect(toastMock.mock.calls.length).toBe(toasts);
		const history = useContextUsageStore.getState().history.t1;
		expect(history).toHaveLength(CONTEXT_HISTORY_LIMIT);
		expect(history[0].eventId).toBe(`e${CONTEXT_HISTORY_LIMIT + 2}`);
		expect(toastMock).toHaveBeenCalled();
		expect(String(toastMock.mock.calls[0][0].title)).toContain("62");
	});

	it("reflects the drop and clears the pending request when an action lands", () => {
		handleContextEvent("t1", usage(62));
		useContextUsageStore.getState().setPending("t1", "compact");
		handleContextEvent("t1", applied("a", 62, 18));
		const state = useContextUsageStore.getState();
		expect(state.usage.t1.percent).toBe(18);
		expect(state.usage.t1.handoffState).toBe("idle");
		expect(state.pending.t1).toBeUndefined();
	});

	it("ignores events that are not context events", () => {
		handleContextEvent("t1", { type: "QA_PASSED" });
		expect(useContextUsageStore.getState().usage).toEqual({});
	});

	it("knows which statuses have a live session", () => {
		expect(isContextActiveStatus("in_progress")).toBe(true);
		expect(isContextActiveStatus("ai_review")).toBe(true);
		expect(isContextActiveStatus("human_review")).toBe(false);
		expect(isContextActiveStatus(undefined)).toBe(false);
	});
});

describe("setupContextUsageListeners", () => {
	const api = globalThis.electronAPI as unknown as Record<string, unknown>;
	let usageCallback: ((taskId: string, event: unknown) => void) | null = null;
	let statusCallback: ((taskId: string, status: string) => void) | null = null;
	const original = {
		onTaskContextUsage: api.onTaskContextUsage,
		onTaskStatusChange: api.onTaskStatusChange,
	};
	const unsubscribe = vi.fn();

	beforeEach(() => {
		api.onTaskContextUsage = vi.fn((cb) => {
			usageCallback = cb;
			return unsubscribe;
		});
		api.onTaskStatusChange = vi.fn((cb) => {
			statusCallback = cb;
			return unsubscribe;
		});
	});

	afterEach(() => {
		Object.assign(api, original);
	});

	it("registers once, feeds the store, and clears a task that stopped", () => {
		const teardown = setupContextUsageListeners();
		expect(setupContextUsageListeners()).toBe(teardown);
		expect(api.onTaskContextUsage).toHaveBeenCalledTimes(1);

		usageCallback?.("t1", usage(55));
		expect(useContextUsageStore.getState().usage.t1.percent).toBe(55);

		statusCallback?.("t1", "ai_review");
		expect(useContextUsageStore.getState().usage.t1).toBeDefined();
		statusCallback?.("t1", "human_review");
		expect(useContextUsageStore.getState().usage.t1).toBeUndefined();

		teardown();
		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});
});
