/**
 * The device matrix bridge forwards, on its own channels, a device id, a
 * path, two profile ids, an orientation and a session choice, or a list of
 * device ids, a format and a markers choice, and nothing else the caller adds.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ success: false, error: "busy" })));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createDeviceMatrixAPI } from "../device-matrix-api";

describe("createDeviceMatrixAPI", () => {
	it("invokes app-emulator:capture-device with the device, the path, the profiles, the orientation and the session choice only", async () => {
		const request = {
			deviceId: "pixel-8",
			path: "/cart",
			network: "slow-3g",
			cpu: "4x",
			orientation: "landscape",
			previewSession: true,
			url: "https://evil.example",
		};
		await createDeviceMatrixAPI().captureEmulatorDevice(request);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, {
			deviceId: "pixel-8",
			path: "/cart",
			network: "slow-3g",
			cpu: "4x",
			orientation: "landscape",
			previewSession: true,
		});
	});

	it("invokes app-emulator:export-device-grid with the device ids, the format and the markers choice only", async () => {
		const request = { deviceIds: ["pixel-8"], format: "pdf", markers: true, filePath: "/etc/passwd" };
		await createDeviceMatrixAPI().exportEmulatorDeviceGrid(request);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID, {
			deviceIds: ["pixel-8"],
			format: "pdf",
			markers: true,
		});
	});
});
