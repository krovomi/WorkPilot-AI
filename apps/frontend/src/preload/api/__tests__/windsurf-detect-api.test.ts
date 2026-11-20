/**
 * The bridge offers the renderer two Windsurf calls without arguments: one
 * that asks whether the local IDE holds a key, one that has the main process
 * save it. Neither takes a key from the renderer.
 */

import { ipcRenderer } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createElectronAPI } from "..";

describe("Windsurf detected token bridge", () => {
	it("invokes its own channel for each call, with no argument", async () => {
		const invoke = vi
			.spyOn(ipcRenderer, "invoke")
			.mockResolvedValue({ success: true });
		const api = createElectronAPI();

		await api.detectWindsurfToken();
		await api.saveDetectedWindsurfToken();

		expect(invoke.mock.calls).toEqual([
			[IPC_CHANNELS.CREDENTIAL_DETECT_WINDSURF_TOKEN],
			[IPC_CHANNELS.CREDENTIAL_SAVE_DETECTED_WINDSURF_TOKEN],
		]);
		invoke.mockRestore();
	});
});
