/**
 * The device matrix store (#383): devices are captured one after the other in
 * catalogue order under the chosen throttling, a stop keeps what was
 * rendered, a failure is named, and the export names the rendered devices.
 * A task under review gets its default devices captured once, unasked.
 * Custom devices follow the catalogue, a persona replaces the preview's
 * session, and the breakpoint scan runs here too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATRIX_DEVICE_IDS } from "../../../shared/constants/device-presets";
import type { DeviceCapture } from "../../../shared/types/device-matrix";
import { useDeviceLibraryStore } from "../device-library-store";
import { useDeviceMatrixStore } from "../device-matrix-store";

const captureEmulatorDevice = vi.fn();
const exportEmulatorDeviceGrid = vi.fn();
const scanEmulatorBreakpoints = vi.fn();
Object.defineProperty(globalThis, "electronAPI", {
	value: { captureEmulatorDevice, exportEmulatorDeviceGrid, scanEmulatorBreakpoints },
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
		orientation: "portrait",
		width: 393,
		height: 852,
		previewSession: false,
		persona: null,
	},
});

const CUSTOM = "custom-11111111-2222-4333-8444-555555555555";
const PERSONA = "persona-11111111-2222-4333-8444-555555555555";
const foldable = {
	id: CUSTOM,
	name: "Flip 6",
	category: "phone" as const,
	width: 360,
	height: 748,
	deviceScaleFactor: 3,
	mobile: true,
	touch: true,
	userAgent: "UA",
};

describe("useDeviceMatrixStore", () => {
	beforeEach(() => {
		captureEmulatorDevice.mockReset();
		exportEmulatorDeviceGrid.mockReset();
		scanEmulatorBreakpoints.mockReset();
		useDeviceLibraryStore.setState({ customDevices: [] });
		useDeviceMatrixStore.setState({
			selected: [...DEFAULT_MATRIX_DEVICE_IDS],
			entries: {},
			running: false,
			stopRequested: false,
			network: "none",
			cpu: "1x",
			orientation: "portrait",
			previewSession: false,
			persona: null,
			scan: null,
			showMarkers: true,
			autoCaptured: [],
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
		useDeviceMatrixStore.getState().setOrientation("landscape");
		useDeviceMatrixStore.getState().setPreviewSession(true);
		await useDeviceMatrixStore.getState().captureSelected("/cart");
		const throttled = { network: "fast-3g", cpu: "4x", orientation: "landscape", previewSession: true, persona: null };
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
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(exportEmulatorDeviceGrid).toHaveBeenCalledWith({
			deviceIds: ["iphone-15", "desktop-1080p"],
			format: "png",
			markers: true,
		});
		expect(useDeviceMatrixStore.getState()).toMatchObject({
			exporting: false,
			exportStatus: { status: "saved", fileName: "grid.png" },
		});
	});

	it("says nothing after a cancelled export, and names a failed one", async () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "done", capture: capture("iphone-15").data } } });
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: true, data: { saved: false } });
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(useDeviceMatrixStore.getState().exportStatus).toBeNull();
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: false, error: "write-failed" });
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(useDeviceMatrixStore.getState().exportStatus).toEqual({ status: "failed", error: "write-failed" });
		exportEmulatorDeviceGrid.mockRejectedValueOnce(new Error("bridge gone"));
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(useDeviceMatrixStore.getState().exportStatus).toEqual({ status: "failed", error: "export-failed" });
		// A new capture or a clear forgets the last export.
		useDeviceMatrixStore.getState().clear();
		expect(useDeviceMatrixStore.getState().exportStatus).toBeNull();
	});

	it("exports nothing without a rendered device, while capturing or while exporting", async () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "failed", error: "busy" } } });
		await useDeviceMatrixStore.getState().exportGrid("png");
		const done = { "iphone-15": { status: "done" as const, capture: capture("iphone-15").data } };
		useDeviceMatrixStore.setState({ entries: done, running: true });
		await useDeviceMatrixStore.getState().exportGrid("png");
		useDeviceMatrixStore.setState({ running: false, exporting: true });
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(exportEmulatorDeviceGrid).not.toHaveBeenCalled();
	});

	it("exports a PDF without markers when the markers are off", async () => {
		useDeviceMatrixStore.setState({ entries: { "iphone-15": { status: "done", capture: capture("iphone-15").data } } });
		useDeviceMatrixStore.getState().setShowMarkers(false);
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: true, data: { saved: true, fileName: "grid.pdf" } });
		await useDeviceMatrixStore.getState().exportGrid("pdf");
		expect(exportEmulatorDeviceGrid).toHaveBeenCalledWith({ deviceIds: ["iphone-15"], format: "pdf", markers: false });
	});

	it("captures the given devices instead of the selection, in catalogue order", async () => {
		captureEmulatorDevice.mockImplementation(async ({ deviceId }) => capture(deviceId));
		await useDeviceMatrixStore.getState().captureSelected("/", ["desktop-1080p", "made-up", "pixel-8"]);
		expect(captureEmulatorDevice.mock.calls.map(([request]) => request.deviceId)).toEqual(["pixel-8", "desktop-1080p"]);
		expect(useDeviceMatrixStore.getState().selected).toEqual([...DEFAULT_MATRIX_DEVICE_IDS]);
	});

	it("captures the default devices once per key, unasked", async () => {
		useDeviceMatrixStore.getState().setSelection(["tv-1080p"]);
		captureEmulatorDevice.mockImplementation(async ({ deviceId }) => capture(deviceId));
		expect(useDeviceMatrixStore.getState().autoCapture("task-1", "/cart")).toBe(true);
		await vi.waitFor(() => expect(useDeviceMatrixStore.getState().running).toBe(false));
		expect(captureEmulatorDevice.mock.calls.map(([request]) => [request.deviceId, request.path])).toEqual(
			DEFAULT_MATRIX_DEVICE_IDS.map((id) => [id, "/cart"]),
		);
		expect(useDeviceMatrixStore.getState().autoCaptured).toEqual(["task-1"]);
		expect(useDeviceMatrixStore.getState().autoCapture("task-1", "/cart")).toBe(false);
		useDeviceMatrixStore.setState({ running: true });
		expect(useDeviceMatrixStore.getState().autoCapture("task-2", "/")).toBe(false);
		useDeviceMatrixStore.setState({ running: false, exporting: true });
		expect(useDeviceMatrixStore.getState().autoCapture("task-2", "/")).toBe(false);
		expect(captureEmulatorDevice).toHaveBeenCalledTimes(DEFAULT_MATRIX_DEVICE_IDS.length);
	});

	it("puts custom devices after the catalogue, and exports them by id", async () => {
		useDeviceLibraryStore.setState({ customDevices: [foldable] });
		useDeviceMatrixStore.getState().setSelection([CUSTOM, "tv-1080p", "custom-gone"]);
		expect(useDeviceMatrixStore.getState().selected).toEqual(["tv-1080p", CUSTOM]);
		useDeviceMatrixStore.setState({
			entries: {
				[CUSTOM]: { status: "done", capture: capture(CUSTOM).data },
				"tv-1080p": { status: "done", capture: capture("tv-1080p").data },
			},
		});
		exportEmulatorDeviceGrid.mockResolvedValueOnce({ success: true, data: { saved: false } });
		await useDeviceMatrixStore.getState().exportGrid("png");
		expect(exportEmulatorDeviceGrid.mock.calls[0][0].deviceIds).toEqual(["tv-1080p", CUSTOM]);
	});

	it("chooses a persona or the preview's session, never both", async () => {
		const store = useDeviceMatrixStore.getState();
		store.setPreviewSession(true);
		store.setPersona(PERSONA);
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: false, persona: PERSONA });
		captureEmulatorDevice.mockImplementation(async ({ deviceId }) => capture(deviceId));
		await useDeviceMatrixStore.getState().captureSelected("/", ["pixel-8"]);
		expect(captureEmulatorDevice.mock.calls[0][0]).toMatchObject({ previewSession: false, persona: PERSONA });
		store.setPreviewSession(true);
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: true, persona: null });
		store.setPersona(null);
		store.setPreviewSession(false);
		expect(useDeviceMatrixStore.getState()).toMatchObject({ previewSession: false, persona: null });
	});

	it("scans the breakpoints with the session chosen, and names a failure", async () => {
		const scan = { deviceId: "desktop-1080p", url: "http://localhost:5173/", breakpoints: [768], steps: [] };
		scanEmulatorBreakpoints.mockImplementationOnce(async () => {
			expect(useDeviceMatrixStore.getState().scan).toEqual({ status: "running", deviceId: "desktop-1080p" });
			return { success: true, data: scan };
		});
		useDeviceMatrixStore.getState().setPersona(PERSONA);
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/pricing");
		expect(scanEmulatorBreakpoints).toHaveBeenCalledWith({
			deviceId: "desktop-1080p",
			path: "/pricing",
			previewSession: false,
			persona: PERSONA,
		});
		expect(useDeviceMatrixStore.getState().scan).toEqual({ status: "done", scan });
		scanEmulatorBreakpoints.mockResolvedValueOnce({ success: false, error: "not-running" });
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/");
		expect(useDeviceMatrixStore.getState().scan).toEqual({ status: "failed", error: "not-running" });
		scanEmulatorBreakpoints.mockRejectedValueOnce(new Error("bridge gone"));
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/");
		expect(useDeviceMatrixStore.getState().scan).toEqual({ status: "failed", error: "capture-failed" });
	});

	it("never scans beside a capture, an export or another scan, nor captures beside a scan", async () => {
		useDeviceMatrixStore.setState({ running: true });
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/");
		useDeviceMatrixStore.setState({ running: false, exporting: true });
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/");
		useDeviceMatrixStore.setState({ exporting: false, scan: { status: "running", deviceId: "ipad-mini" } });
		await useDeviceMatrixStore.getState().scanBreakpoints("desktop-1080p", "/");
		await useDeviceMatrixStore.getState().captureSelected("/");
		expect(scanEmulatorBreakpoints).not.toHaveBeenCalled();
		expect(captureEmulatorDevice).not.toHaveBeenCalled();
	});
});
