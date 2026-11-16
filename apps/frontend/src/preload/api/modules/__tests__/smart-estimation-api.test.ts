/**
 * The calibration writes of the Smart Estimation bridge: one constant channel
 * each, the renderer passing a project id and scores, never a path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
	ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createSmartEstimationAPI } from "../smart-estimation-api";

beforeEach(() => invoke.mockReset());

describe("smart estimation calibration bridge", () => {
	it("sends an adjustment on its own channel", async () => {
		invoke.mockResolvedValue({ samples: 0, adjustments: 1, reset_at: null });
		const request = {
			projectId: "p1",
			category: "backend" as const,
			baseScore: 5,
			adjustedScore: 8,
		};
		await expect(createSmartEstimationAPI().adjustSmartEstimate(request)).resolves.toEqual({
			samples: 0,
			adjustments: 1,
			reset_at: null,
		});
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.SMART_ESTIMATION_ADJUST, request);
	});

	it("sends a reset with the project id only", async () => {
		invoke.mockResolvedValue({ samples: 0, adjustments: 0, reset_at: "now" });
		await createSmartEstimationAPI().resetEstimationCalibration("p1");
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.SMART_ESTIMATION_RESET_CALIBRATION, {
			projectId: "p1",
		});
	});
});
