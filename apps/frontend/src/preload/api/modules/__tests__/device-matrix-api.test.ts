/**
 * The device matrix bridge forwards, on its own channels, a device id, a
 * path, two profile ids, an orientation and a session choice, or a list of
 * device ids, a format and a markers choice, and nothing else the caller adds.
 * The same goes for the breakpoint scan, the custom devices and the personas.
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
			persona: null,
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
			persona: null,
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

	it("invokes app-emulator:scan-breakpoints with the device, the path and the session choice only", async () => {
		const request = { deviceId: "desktop-1080p", path: "/", previewSession: false, persona: "persona-x", widths: [1] };
		await createDeviceMatrixAPI().scanEmulatorBreakpoints(request);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS, {
			deviceId: "desktop-1080p",
			path: "/",
			previewSession: false,
			persona: "persona-x",
		});
	});

	it("sends a custom device's fields only, and names devices and personas by id", async () => {
		const api = createDeviceMatrixAPI();
		const draft = {
			name: "Flip",
			width: 360,
			height: 748,
			deviceScaleFactor: 3,
			mobile: true,
			touch: true,
			userAgent: "UA",
			id: "desktop-1080p",
		};
		await api.saveEmulatorCustomDevice(draft);
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, {
			name: "Flip",
			width: 360,
			height: 748,
			deviceScaleFactor: 3,
			mobile: true,
			touch: true,
			userAgent: "UA",
		});
		await api.listEmulatorCustomDevices();
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES);
		await api.deleteEmulatorCustomDevice("custom-x");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE, { id: "custom-x" });
		await api.listEmulatorPersonas();
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS);
		await api.saveEmulatorPersona("Admin");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: "Admin" });
		await api.deleteEmulatorPersona("persona-x");
		expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA, { id: "persona-x" });
	});
});
