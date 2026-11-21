/**
 * The device matrix store (#383): devices are captured one after the other in
 * catalogue order under the chosen throttling, a stop keeps what was
 * rendered, a failure is named, and the export names the rendered devices.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATRIX_DEVICE_IDS } from "../../../shared/constants/device-presets";
import type { DeviceCapture } from "../../../shared/types/device-matrix";
import { useDeviceMatrixStore } from "../device-matrix-store";

const captureEmulatorDevice = vi.fn();
const exportEmulatorDeviceGrid = vi.fn();
Object.defineProperty(globalThis, "electronAPI", {
	value: { captureEmulatorDevice, exportEmulatorDeviceGrid },
	writable: true,
});

const capture = (deviceId: string): { success: true; data: DeviceCapture } => ({
	success: true,
	data: {
		deviceId,
		url: "http://localhost:5173/",
		image: "data:image/png;base64,AA==",
		report: null,
		network: "none",
		cpu: "1x",
		loadMs: 0,
	},
});

describe("useDeviceMatrixStore", () => {
	beforeEach(() => {
		captureEmulatorDevice.mockReset();
		exportEmulatorDeviceGrid.mockReset();
		useDeviceMatrixStore.setState({
			selected: [...DEFAULT_MATRIX_DEVICE_IDS],
			entries: {},
			running: false,
			stopRequested: false,
			network: "none",
			cpu: "1x",
			exporting: false,
			exportStatus: null,
		});
	});

	it("keeps the selection in catalogue order and drops unknown ids", () => {
		const store = useDeviceMatrixStore.getState();
		store.setSelection(["desktop-1080p", "made-up", "iphone-15"]);
		expect(useDeviceMatrixStore.getState().selected).toEqual(["iphone-15", "desktop-1080p"]);
		store.toggleDevice("pixel-8");
		store.toggleDevice("iphone-15");
		expect(useDeviceMatrixStore.getState().selected).toEqual(["pixel-8", "desktop-1080p"]);
	});

	it("captures each selected device in turn, naming failures", async () => {
		useDeviceMatrixStore.getState().setSelection(["iphone-15", "pixel-8", "ipad-mini"]);
		captureEmulatorDevice
			.mockImplementationOnce(async ({ deviceId }) => {
				expect(useDeviceMatrixStore.getState().entries).toMatchObject({
					"iphone-15": { status: "capturing" },
					"pixel-8": { status: "pending" },
				});
				return capture(deviceId);
			})
			.mockResolvedValueOnce({ success: false, error: "load-failed" })
			.mockRejectedValueOnce(new Error("bridge gone"));
		useDeviceMatrixStore.getState().setNetwork("fast-3g");
		useDeviceMatrixStore.getState().setCpu("4x");
		await useDeviceMatrixStore.getState().captureSelected("/cart");
		const throttled = { network: "fast-3g", cpu: "4x" };
		expect(captureEmulatorDevice.mock.calls.map(([request]) => request)).toEqual([
			{ deviceId: "iphone-15", path: "/cart", ...throttled },
			{ deviceId: "pixel-8", path: "/cart", ...throttled },
			{ deviceId: "ipad-mini", path: "/cart", ...throttled },
		]);
		const { entries, running } = useDeviceMatrixStore.getState();
		expect(running).toBe(false);
		expect(entries["iphone-15"]).toMatchObject({ status: "done" });
		expect(entries["pixel-8"]).toEqual({ status: "failed", error: "load-failed" });
		expect(entries["ipad-mini"]).toEqual({ status: "failed", error: "capture-failed" });
	});

	it("stops after the device in progress and drops the ones not rendered", async () => {
		captureEmulatorDevice.mockImplementation(async ({ deviceId }) => {
			useDeviceMatrixStore.getState().stop();
			return capture(deviceId);
		});
		await useDeviceMatrixStore.getState().captureSelected("/");
		expect(captureEmulatorDevice).toHaveBeenCalledTimes(1);
		expect(Object.keys(useDeviceMatrixStore.getState().entries)).toEqual(["iphone-15"]);
		expect(useDeviceMatrixStore.getState().stopRequested).toBe(false);
	});

	it("does nothing without a selection, while running, or to stop when idle", async () => {
		useDeviceMatrixStore.getState().stop();
		expect(useDeviceMatrixStore.getState().stopRequested).toBe(false);
		useDeviceMatrixStore.getState().setSelection([]);
		await useDeviceMatrixStore.getState().captureSelected("/");
		useDeviceMatrixStore.setState({ selected: ["iphone-15"], running: true });
		await useDeviceMatrixStore.getState().captureSelected("/");
		useDeviceMatrixStore.setState({ running: false, exporting: true });
		await useDeviceMatrixStore.getState().captureSelected("/");
		expect(captureEmulatorDevice).not.toHaveBeenCalled();
	});

	it("clears the captures only when no capture runs", () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "pending" } }, running: true });
		useDeviceMatrixStore.getState().clear();
		expect(useDeviceMatrixStore.getState().entries).not.toEqual({});
		useDeviceMatrixStore.setState({ running: false });
		useDeviceMatrixStore.getState().clear();
		expect(useDeviceMatrixStore.getState().entries).toEqual({});
	});

	it("exports the rendered devices, in catalogue order, and says where it saved", async () => {
		useDeviceMatrixStore.setState({
			entries: {
				"desktop-1080p": { status: "done", capture: capture("desktop-1080p").data },
				"pixel-8": { status: "failed", error: "load-failed" },
				"iphone-15": { status: "done", capture: capture("iphone-15").data },
			},
			exportStatus: { status: "failed", error: "busy" },
		});
		exportEmulatorDeviceGrid.mockImplementationOnce(async () => {
			expect(useDeviceMatrixStore.getState()).toMatchObject({ exporting: true, exportStatus: null });
			return { success: true, data: { saved: true, fileName: "grid.png" } };
		});
		await useDeviceMatrixStore.getState().exportGrid();
		expect(exportEmulatorDeviceGrid).toHaveBeenCalledWith({ deviceIds: ["iphone-15", "desktop-1080p"] });
		expect(useDeviceMatrixStore.getState()).toMatchObject({
			exporting: false,
			exportStatus: { status: "saved", fileName: "grid.png" },
		});
	});

	it("says nothing after a cancelled export, and names a failed one", async () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "done", capture: capture("iphone-15").data } } });
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: true, data: { saved: false } });
		await useDeviceMatrixStore.getState().exportGrid();
		expect(useDeviceMatrixStore.getState().exportStatus).toBeNull();
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: false, error: "write-failed" });
		await useDeviceMatrixStore.getState().exportGrid();
		expect(useDeviceMatrixStore.getState().exportStatus).toEqual({ status: "failed", error: "write-failed" });
		exportEmulatorDeviceGrid.mockRejectedValueOnce(new Error("bridge gone"));
		await useDeviceMatrixStore.getState().exportGrid();
		expect(useDeviceMatrixStore.getState().exportStatus).toEqual({ status: "failed", error: "export-failed" });
		// A new capture or a clear forgets the last export.
		useDeviceMatrixStore.getState().clear();
		expect(useDeviceMatrixStore.getState().exportStatus).toBeNull();
	});

	it("exports nothing without a rendered device, while capturing or while exporting", async () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "failed", error: "busy" } } });
		await useDeviceMatrixStore.getState().exportGrid();
		const done = { "iphone-15": { status: "done" as const, capture: capture("iphone-15").data } };
		useDeviceMatrixStore.setState({ entries: done, running: true });
		await useDeviceMatrixStore.getState().exportGrid();
		useDeviceMatrixStore.setState({ running: false, exporting: true });
		await useDeviceMatrixStore.getState().exportGrid();
		expect(exportEmulatorDeviceGrid).not.toHaveBeenCalled();
	});
});
