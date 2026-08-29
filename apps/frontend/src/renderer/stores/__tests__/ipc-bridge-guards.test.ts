/**
 * Swarm and Continuous AI reached for `electronAPI.swarm` / `electronAPI.continuousAI`
 * that no preload module ever created. Both features were written on both
 * sides — four and seven `ipcMain.handle` channels, a store calling every one
 * of them — with nothing joining the halves.
 *
 * The Continuous AI case was the visible one. `setConfig` pushed the new config
 * through an optional chain:
 *
 *     globalThis.electronAPI?.continuousAI?.updateConfig(c).catch(() => {})
 *
 * Optional chaining short-circuits the *whole* chain, `.catch` included, so a
 * missing bridge made the expression evaluate to `undefined` without a sound.
 * Every toggle in Settings → Continuous AI looked applied and none of it ever
 * reached the daemon.
 *
 * These tests lock the contract the bridges now have to honour: with no bridge
 * at all, nothing throws and the store says so — it never reports success.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

function setElectronAPI(value: unknown): void {
	Object.defineProperty(globalThis, "electronAPI", {
		value,
		writable: true,
		configurable: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

import { useContinuousAIStore } from "../continuous-ai-store";
import { useSwarmStore } from "../swarm-store";

describe("swarm store without an IPC bridge", () => {
	beforeEach(() => {
		setElectronAPI({});
		useSwarmStore.getState().reset();
	});

	it("reports the bridge is missing instead of throwing a TypeError", async () => {
		await expect(
			useSwarmStore.getState().analyzeSpec("001-demo"),
		).resolves.toBeUndefined();

		const state = useSwarmStore.getState();
		expect(state.error).toMatch(/unavailable/i);
		// The spinner must not be left running on a call that never happened.
		expect(state.isAnalyzing).toBe(false);
		expect(state.analysisStats).toBe(null);
	});

	it("does not pretend a run started", async () => {
		await useSwarmStore.getState().startSwarm("001-demo");

		const state = useSwarmStore.getState();
		expect(state.error).toMatch(/unavailable/i);
		expect(state.isExecuting).toBe(false);
	});

	it("cancels quietly — there is nothing to cancel", async () => {
		await expect(useSwarmStore.getState().cancelSwarm()).resolves.toBeUndefined();
	});
});

describe("swarm store with a bridge", () => {
	const analyze = vi.fn();
	const start = vi.fn();

	beforeEach(() => {
		analyze.mockResolvedValue({
			type: "analysis_complete",
			parallelismStats: {
				totalWaves: 2,
				maxParallelism: 3,
				avgParallelism: 2,
				waveSizes: [3, 1],
				totalSubtasks: 4,
				speedupEstimate: 1.8,
			},
		});
		start.mockResolvedValue({ success: true, pid: 42 });
		setElectronAPI({ swarm: { analyze, start, cancel: vi.fn() } });
		useSwarmStore.getState().reset();
	});

	it("passes the spec id and the current config through to the handler", async () => {
		await useSwarmStore.getState().analyzeSpec("001-demo");

		expect(analyze).toHaveBeenCalledWith(
			"001-demo",
			useSwarmStore.getState().config,
		);
		expect(useSwarmStore.getState().analysisStats).not.toBe(null);
		expect(useSwarmStore.getState().error).toBe(null);
	});
});

describe("continuous AI store without an IPC bridge", () => {
	beforeEach(() => {
		setElectronAPI({});
		useContinuousAIStore.getState().reset();
	});

	it("warns rather than silently dropping a config change", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			/* keep the test output clean */
		});

		expect(() =>
			useContinuousAIStore.getState().setConfig({ enabled: true }),
		).not.toThrow();

		// The user's choice still lands in the store — it is the daemon that
		// never hears about it, and that is what has to be said out loud.
		expect(useContinuousAIStore.getState().config.enabled).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("[continuous-ai]"),
		);
	});

	it("surfaces an error rather than a hung spinner when starting", async () => {
		await useContinuousAIStore.getState().startDaemon();

		const state = useContinuousAIStore.getState();
		expect(state.error).toMatch(/unavailable/i);
		expect(state.isStarting).toBe(false);
	});

	it("stops and refreshes without throwing", async () => {
		await expect(
			useContinuousAIStore.getState().stopDaemon(),
		).resolves.toBeUndefined();
		await expect(
			useContinuousAIStore.getState().refreshStatus(),
		).resolves.toBeUndefined();
	});
});

describe("continuous AI store with a bridge", () => {
	const updateConfig = vi.fn();

	beforeEach(() => {
		updateConfig.mockResolvedValue({ success: true });
		setElectronAPI({ continuousAI: { updateConfig } });
		useContinuousAIStore.getState().reset();
	});

	it("pushes the merged config to the daemon", () => {
		useContinuousAIStore.getState().setConfig({ enabled: true });

		expect(updateConfig).toHaveBeenCalledTimes(1);
		expect(updateConfig).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true }),
		);
	});
});
