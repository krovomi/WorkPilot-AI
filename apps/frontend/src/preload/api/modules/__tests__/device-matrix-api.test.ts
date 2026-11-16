/**
 * The device matrix bridge forwards a device id and a path on its own
 * channel, and nothing else the caller adds.
 */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ success: false, error: "busy" })));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createDeviceMatrixAPI } from "../device-matrix-api";

describe("createDeviceMatrixAPI", () => {
	it("invokes app-emulator:capture-device with the device and the path only", async () => {
		const request = { deviceId: "pixel-8", path: "/cart", url: "https://evil.example" };
		await createDeviceMatrixAPI().captureEmulatorDevice(request);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, {
			deviceId: "pixel-8",
			path: "/cart",
		});
	});
});
