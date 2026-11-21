/**
 * The bridge's two screenshot calls reach their own channel, the capture with
 * the options the renderer gave, and hand back the main process's answer as is.
 */

import { ipcRenderer } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createScreenshotAPI } from "../screenshot-api";

describe("screenshot bridge", () => {
	it("invokes its own channel for each call", async () => {
		const invoke = vi
			.spyOn(ipcRenderer, "invoke")
			.mockResolvedValueOnce({ success: false, devMode: true })
			.mockResolvedValueOnce({ success: false, error: "source_not_found" });
		const api = createScreenshotAPI();

		expect(await api.getSources()).toEqual({ success: false, devMode: true });
		expect(await api.capture({ sourceId: "screen:0:0" })).toEqual({
			success: false,
			error: "source_not_found",
		});
		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.SCREENSHOT_GET_SOURCES],
			[IPC_CHANNELS.SCREENSHOT_CAPTURE, { sourceId: "screen:0:0" }],
		]);
		invoke.mockRestore();
	});
});
