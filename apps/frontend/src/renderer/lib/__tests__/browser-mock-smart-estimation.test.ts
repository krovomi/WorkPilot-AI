// @vitest-environment jsdom
/**
 * The browser preview has no backend: the calibration writes fail loudly
 * rather than pretend the repository's calibration changed.
 */

import { describe, expect, it } from "vitest";
import type { ElectronAPI } from "../../../shared/types";

describe("browser mock: smart estimation calibration", () => {
	it("refuses both calibration writes", async () => {
		// Outside Electron there is no bridge: the mock installs itself.
		Reflect.deleteProperty(window, "electronAPI");
		await import("../browser-mock");
		const api = window.electronAPI as ElectronAPI;
		await expect(
			api.adjustSmartEstimate({
				projectId: "p",
				category: "backend",
				baseScore: 3,
				adjustedScore: 5,
			}),
		).rejects.toThrow("browser preview");
		await expect(api.resetEstimationCalibration("p")).rejects.toThrow(
			"browser preview",
		);
	});
});
