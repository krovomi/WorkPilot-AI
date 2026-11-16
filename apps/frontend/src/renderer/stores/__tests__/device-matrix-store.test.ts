/**
 * The device matrix store (#383): devices are captured one after the other in
 * catalogue order, a stop keeps what was rendered, and a failure is named.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATRIX_DEVICE_IDS } from "../../../shared/constants/device-presets";
import { useDeviceMatrixStore } from "../device-matrix-store";

const captureEmulatorDevice = vi.fn();
Object.defineProperty(globalThis, "electronAPI", { value: { captureEmulatorDevice }, writable: true });

const capture = (deviceId: string) => ({
	success: true,
	data: { deviceId, url: "http://localhost:5173/", image: "data:image/png;base64,AA==", report: null },
});

describe("useDeviceMatrixStore", () => {
	beforeEach(() => {
		captureEmulatorDevice.mockReset();
		useDeviceMatrixStore.setState({
			selected: [...DEFAULT_MATRIX_DEVICE_IDS],
			entries: {},
			running: false,
			stopRequested: false,
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
		await useDeviceMatrixStore.getState().captureSelected("/cart");
		expect(captureEmulatorDevice.mock.calls.map(([request]) => request)).toEqual([
			{ deviceId: "iphone-15", path: "/cart" },
			{ deviceId: "pixel-8", path: "/cart" },
			{ deviceId: "ipad-mini", path: "/cart" },
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
});
