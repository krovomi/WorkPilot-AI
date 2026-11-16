/**
 * The bisect state of the self-healing store (#375), and the dashboard's
 * trends and clusters (#370, #372): a run is shown from its start, a step
 * as it streams, and a failure as a failure, whatever the main process says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BisectProgressEvent, SelfHealingDashboardData } from "../../../shared/types/self-healing";
import { setupSelfHealingListeners, useSelfHealingStore } from "../self-healing-store";

const SHA = "a".repeat(40);
const bisectIncident = vi.fn();
const fetchDashboard = vi.fn(async () => undefined);

function step(tested: number): BisectProgressEvent {
	return {
		incidentId: "inc1",
		step: { sha: SHA, outcome: "bad", role: "search", seconds: 1, detail: "", tested },
	};
}

beforeEach(() => {
	bisectIncident.mockReset();
	fetchDashboard.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = { selfHealing: { bisectIncident } };
	useSelfHealingStore.setState({ bisects: {}, fetchDashboard });
});

afterEach(() => {
	delete (globalThis as { electronAPI?: unknown }).electronAPI;
});

describe("startBisect", () => {
	it("keeps the streamed steps and the verdict, then reads the dashboard again", async () => {
		const result = { status: "found", first_bad: SHA };
		bisectIncident.mockImplementation(async () => {
			useSelfHealingStore.getState().applyBisectProgress(step(1));
			return { success: true, result };
		});
		await useSelfHealingStore.getState().startBisect("/proj", "inc1", "abc1234");
		expect(bisectIncident).toHaveBeenCalledWith("/proj", "inc1", "abc1234");
		const run = useSelfHealingStore.getState().bisects.inc1;
		expect(run).toMatchObject({ running: false, result });
		expect(run.steps).toHaveLength(1);
		expect(fetchDashboard).toHaveBeenCalledWith("/proj");
	});

	it("sends no commit when none is typed and reports a refusal", async () => {
		bisectIncident.mockResolvedValueOnce({ success: false, error: "invalid commit id" });
		await useSelfHealingStore.getState().startBisect("/proj", "inc1", "");
		expect(bisectIncident).toHaveBeenCalledWith("/proj", "inc1", undefined);
		expect(useSelfHealingStore.getState().bisects.inc1).toEqual({
			running: false,
			steps: [],
			error: "invalid commit id",
		});

		bisectIncident.mockResolvedValueOnce({ success: false });
		await useSelfHealingStore.getState().startBisect("/proj", "inc1");
		expect(useSelfHealingStore.getState().bisects.inc1.error).toBe("bisect failed");
		expect(fetchDashboard).not.toHaveBeenCalled();
	});

	it("reports a call that throws", async () => {
		bisectIncident.mockRejectedValueOnce(new Error("channel closed"));
		await useSelfHealingStore.getState().startBisect("/proj", "inc1");
		expect(useSelfHealingStore.getState().bisects.inc1.error).toBe("Error: channel closed");
	});
});

describe("applyBisectProgress", () => {
	it("starts a run for a step it did not see begin, and keeps the last 50", () => {
		const { applyBisectProgress } = useSelfHealingStore.getState();
		applyBisectProgress(step(1));
		expect(useSelfHealingStore.getState().bisects.inc1.running).toBe(true);
		for (let tested = 2; tested <= 60; tested++) applyBisectProgress(step(tested));
		const steps = useSelfHealingStore.getState().bisects.inc1.steps;
		expect(steps).toHaveLength(50);
		expect(steps[0].tested).toBe(11);
	});
});

describe("setDashboardData", () => {
	it("takes the trends and clusters, or empties them", () => {
		const base = {
			incidents: [],
			activeOperations: [],
			fragilityReports: [],
			stats: useSelfHealingStore.getState().stats,
		} as unknown as SelfHealingDashboardData;
		const riskTrends = { snapshots: 1 } as SelfHealingDashboardData["riskTrends"];
		useSelfHealingStore.getState().setDashboardData({ ...base, riskTrends, incidentClusters: [] });
		expect(useSelfHealingStore.getState().riskTrends).toBe(riskTrends);
		useSelfHealingStore.getState().setDashboardData(base);
		expect(useSelfHealingStore.getState().riskTrends).toBeNull();
		expect(useSelfHealingStore.getState().incidentClusters).toEqual([]);
	});
});

describe("setupSelfHealingListeners", () => {
	it("subscribes to the progress of a bisect once the API is there", () => {
		let listener: ((event: BisectProgressEvent) => void) | undefined;
		const unsubscribe = vi.fn();
		(globalThis as { electronAPI?: unknown }).electronAPI = {
			selfHealing: {
				onBisectProgress: (callback: (event: BisectProgressEvent) => void) => {
					listener = callback;
					return unsubscribe;
				},
			},
		};
		expect(setupSelfHealingListeners()).toBe(unsubscribe);
		listener?.(step(1));
		expect(useSelfHealingStore.getState().bisects.inc1.steps).toHaveLength(1);
	});

	it("does nothing without the API", () => {
		delete (globalThis as { electronAPI?: unknown }).electronAPI;
		expect(setupSelfHealingListeners()()).toBeUndefined();
		(globalThis as { electronAPI?: unknown }).electronAPI = { selfHealing: {} };
		expect(setupSelfHealingListeners()()).toBeUndefined();
	});
});
