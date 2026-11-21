// @vitest-environment jsdom
/**
 * The browser preview has no local Windsurf IDE: detecting and saving the
 * detected token both answer a failure, never a success without a key.
 */

import { describe, expect, it } from "vitest";
import type { ElectronAPI } from "../../../shared/types";

describe("browser mock: Windsurf detected token", () => {
	it("detects nothing and saves nothing", async () => {
		// Outside Electron there is no bridge: the mock installs itself.
		Reflect.deleteProperty(window, "electronAPI");
		await import("../browser-mock");
		const api = window.electronAPI as ElectronAPI;
		const unavailable = {
			success: false,
			error: "Not available in browser mode",
		};
		await expect(api.detectWindsurfToken()).resolves.toEqual(unavailable);
		await expect(api.saveDetectedWindsurfToken()).resolves.toEqual(
			unavailable,
		);
	});
});
