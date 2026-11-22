/**
 * The device matrix channels (#383): the renderer names a catalogue device, a
 * path and two throttling profiles; the origin is always the emulator's own
 * server, a path that leaves it is refused, an unknown profile too, and only
 * one capture runs at a time. An orientation is a name, the preview's session
 * a yes or no. The export names devices, a format and whether to box faulty
 * elements: the images and the boxes are the main's own, the file goes where
 * the save dialog says. A custom device is named like a catalogue one; a
 * persona by its id, its cookies decrypted by the main and never returned. The
 * breakpoint scan takes the same fields as a capture and shares its lock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());
const service = vi.hoisted(() => ({ url: "http://localhost:5173" as string | null }));
const capture = vi.hoisted(() => ({ fn: vi.fn() }));
const exporting = vi.hoisted(() => ({
	dialog: vi.fn(),
	compose: vi.fn(),
	write: vi.fn(),
	language: "en",
}));

const library = vi.hoisted(() => ({ custom: [] as { id: string; [key: string]: unknown }[] }));
const persona = vi.hoisted(() => ({ cookies: vi.fn() }));
const scan = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../../device-matrix/custom-devices", async () => {
	const { findDevicePreset } = await import("../../../shared/constants/device-presets");
	return {
		listCustomDevices: async () => library.custom,
		findDevice: async (id: unknown) => findDevicePreset(id) ?? library.custom.find((device) => device.id === id),
	};
});
vi.mock("../../device-matrix/personas", () => {
	class PersonaFailure extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	}
	return { PersonaFailure, personaCookies: (...args: unknown[]) => persona.cookies(...args) };
});
vi.mock("../../device-matrix/breakpoint-scan", () => ({ scanBreakpoints: (...args: unknown[]) => scan.fn(...args) }));
vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
}));
vi.mock("../../app-emulator-service", () => ({ appEmulatorService: { getUrl: () => service.url } }));
vi.mock("../../device-matrix/device-capture", () => {
	class DeviceCaptureFailure extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	}
	return { DeviceCaptureFailure, captureDevice: (...args: unknown[]) => capture.fn(...args) };
});
vi.mock("../../device-matrix/grid-export", () => ({ composeGrid: (...args: unknown[]) => exporting.compose(...args) }));
vi.mock("../../electron-utils", () => ({ showSaveDialog: (...args: unknown[]) => exporting.dialog(...args) }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => exporting.language }));
vi.mock("node:fs/promises", () => ({ writeFile: (...args: unknown[]) => exporting.write(...args) }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { DEVICE_PRESETS } from "../../../shared/constants/device-presets";
import { DeviceCaptureFailure } from "../../device-matrix/device-capture";
import { PersonaFailure } from "../../device-matrix/personas";
import {
	readCaptureRequest,
	readExportRequest,
	readScanRequest,
	registerDeviceMatrixHandlers,
	resolveCaptureUrl,
	sessionOptions,
} from "../device-matrix-handlers";

const CATALOGUE = new Set(DEVICE_PRESETS.map((device) => device.id));
const PERSONA = "persona-11111111-2222-4333-8444-555555555555";
const CUSTOM = "custom-11111111-2222-4333-8444-555555555555";
const foldable = {
	id: CUSTOM,
	name: "Flip 6",
	category: "phone",
	width: 360,
	height: 748,
	deviceScaleFactor: 3,
	mobile: true,
	touch: true,
	userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
};

registerDeviceMatrixHandlers();
const call = (channel: string, raw: unknown) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error("handler not registered");
	return handler({}, raw);
};
/** A capture request: the given fields over a plain one. */
const invoke = (raw: unknown) =>
	call(
		IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE,
		raw && typeof raw === "object"
			? { network: "none", cpu: "1x", orientation: "portrait", previewSession: false, persona: null, ...raw }
			: raw,
	);
/** An export request: the given fields over a plain PNG one. */
const exportGrid = (raw: Record<string, unknown>) =>
	call(IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID, { format: "png", markers: false, ...raw });

const shot = { url: "http://localhost:5173/cart", image: "data:image/png;base64,AA==", report: null, loadMs: 420 };

describe("registerDeviceMatrixHandlers", () => {
	it("registers the custom device and persona channels with the capture ones", () => {
		for (const channel of [
			IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES,
			IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE,
			IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE,
			IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS,
			IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA,
			IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA,
			IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS,
		]) {
			expect(handlers.has(channel)).toBe(true);
		}
	});
});

describe("resolveCaptureUrl", () => {
	it("resolves an absolute path on the server's origin", () => {
		expect(resolveCaptureUrl("http://localhost:5173", "/cart?step=2#pay")).toBe("http://localhost:5173/cart?step=2#pay");
		expect(resolveCaptureUrl("https://localhost:7001/", "/swagger")).toBe("https://localhost:7001/swagger");
	});

	it.each([
		["a relative path", "cart"],
		["a protocol-relative host", "//evil.example/x"],
		["a full URL", "https://evil.example/"],
		["a backslash host", "/\\evil.example"],
		["a control character", "/a\tb"],
		["a DEL character", "/a\u007fb"],
		["an overlong path", `/${"a".repeat(2048)}`],
	])("refuses %s", (_label, path) => {
		expect(resolveCaptureUrl("http://localhost:5173", path)).toBeNull();
	});

	it("refuses a server that is not http(s) or not a URL", () => {
		expect(resolveCaptureUrl("file:///etc", "/passwd")).toBeNull();
		expect(resolveCaptureUrl("not a url", "/")).toBeNull();
	});
});

describe("readCaptureRequest", () => {
	const plain = { network: "none", cpu: "1x", orientation: "portrait", previewSession: false, persona: null };
	it("keeps only a device id, a path, two profile ids, an orientation and a yes or no", () => {
		expect(
			readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, url: "https://evil.example", latency: 0 }),
		).toEqual({ deviceId: "pixel-8", path: "/", ...plain });
		expect(readCaptureRequest(null)).toBeNull();
		expect(readCaptureRequest("pixel-8")).toBeNull();
		expect(readCaptureRequest({ deviceId: 8, path: "/", ...plain })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: ["/"], ...plain })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", cpu: "1x" })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, cpu: 4 })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, orientation: 90 })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, previewSession: "yes" })).toBeNull();
	});

	it("takes a persona id or null, never beside the preview's session", () => {
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, persona: PERSONA })).toMatchObject({
			persona: PERSONA,
		});
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, persona: undefined })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, persona: { id: PERSONA } })).toBeNull();
		expect(
			readCaptureRequest({ deviceId: "pixel-8", path: "/", ...plain, previewSession: true, persona: PERSONA }),
		).toBeNull();
	});
});

describe("readScanRequest", () => {
	it("keeps a device id, a path and a session choice", () => {
		expect(
			readScanRequest({ deviceId: "desktop-1080p", path: "/", previewSession: false, persona: null, widths: [1] }),
		).toEqual({ deviceId: "desktop-1080p", path: "/", previewSession: false, persona: null });
		expect(readScanRequest(null)).toBeNull();
		expect(readScanRequest({ deviceId: 1, path: "/", previewSession: false, persona: null })).toBeNull();
		expect(readScanRequest({ deviceId: "desktop-1080p", path: "/" })).toBeNull();
	});
});

describe("sessionOptions", () => {
	beforeEach(() => {
		persona.cookies = vi.fn(async () => [{ name: "sid" }]);
	});

	it("lends the preview's session, or nothing, without reading a persona", async () => {
		expect(await sessionOptions({ previewSession: true, persona: null }, "http://localhost:5173/")).toEqual({
			previewSession: true,
		});
		expect(persona.cookies).not.toHaveBeenCalled();
	});

	it("replays a persona's cookies, decrypted by the main", async () => {
		expect(await sessionOptions({ previewSession: false, persona: PERSONA }, "http://localhost:5173/")).toEqual({
			previewSession: false,
			persona: [{ name: "sid" }],
		});
		expect(persona.cookies).toHaveBeenCalledWith(PERSONA, "http://localhost:5173/");
	});

	it.each(["unknown-persona", "persona-locked", "persona-elsewhere"])("names a persona that is %s", async (code) => {
		persona.cookies = vi.fn(async () => {
			throw new PersonaFailure(code as "unknown-persona");
		});
		await expect(sessionOptions({ previewSession: false, persona: PERSONA }, "http://localhost:5173/")).rejects.toMatchObject({
			code,
		});
	});

	it("hides any other failure behind session-failed, and refuses an id the main never gave", async () => {
		persona.cookies = vi.fn(async () => {
			throw new PersonaFailure("write-failed");
		});
		await expect(sessionOptions({ previewSession: false, persona: PERSONA }, "http://x/")).rejects.toMatchObject({
			code: "session-failed",
		});
		persona.cookies = vi.fn(async () => {
			throw new Error("keyring: /home/someone");
		});
		await expect(sessionOptions({ previewSession: false, persona: PERSONA }, "http://x/")).rejects.toMatchObject({
			code: "session-failed",
		});
		await expect(sessionOptions({ previewSession: false, persona: "../personas" }, "http://x/")).rejects.toMatchObject({
			code: "unknown-persona",
		});
	});
});

describe("readExportRequest", () => {
	const plain = { format: "png", markers: false };
	it("keeps catalogue ids, once each, in the order received, a known format and a yes or no", () => {
		expect(readExportRequest({ deviceIds: ["pixel-8", "iphone-15", "pixel-8"], ...plain }, CATALOGUE)).toEqual({
			deviceIds: ["pixel-8", "iphone-15"],
			format: "png",
			markers: false,
		});
		expect(readExportRequest({ deviceIds: ["pixel-8"], format: "pdf", markers: true }, CATALOGUE)).toMatchObject({
			format: "pdf",
			markers: true,
		});
	});

	it.each([
		["nothing", null],
		["a string", "pixel-8"],
		["no list", { deviceIds: "pixel-8", ...plain }],
		["an empty list", { deviceIds: [], ...plain }],
		["an unknown id", { deviceIds: ["pixel-8", "../../etc"], ...plain }],
		["a non-string id", { deviceIds: [8], ...plain }],
		["more ids than the catalogue and the custom devices", { deviceIds: Array.from({ length: 31 }, () => "pixel-8"), ...plain }],
		["an unknown format", { deviceIds: ["pixel-8"], format: "svg", markers: false }],
		["no format", { deviceIds: ["pixel-8"], markers: false }],
		["markers that are not a yes or no", { deviceIds: ["pixel-8"], format: "png", markers: "all" }],
	])("refuses %s", (_label, raw) => {
		expect(readExportRequest(raw, CATALOGUE)).toBeNull();
	});
});

describe("APP_EMULATOR_CAPTURE_DEVICE", () => {
	beforeEach(() => {
		service.url = "http://localhost:5173";
		capture.fn = vi.fn(async () => shot);
		library.custom = [];
		persona.cookies = vi.fn(async () => [{ name: "sid" }]);
	});

	it("captures a custom device the main keeps, named by its id", async () => {
		library.custom = [foldable];
		const result = await invoke({ deviceId: CUSTOM, path: "/", orientation: "landscape" });
		expect(result).toMatchObject({ success: true, data: { deviceId: CUSTOM, width: 748, height: 360 } });
		expect(capture.fn.mock.calls[0][0]).toMatchObject({ id: CUSTOM, name: "Flip 6", width: 748, rotated: true });
	});

	it("replays a persona's cookies, and says which persona in the result", async () => {
		const result = await invoke({ deviceId: "pixel-8", path: "/", persona: PERSONA });
		expect(result).toMatchObject({ success: true, data: { persona: PERSONA, previewSession: false } });
		expect(capture.fn.mock.calls[0][3]).toEqual({ previewSession: false, persona: [{ name: "sid" }] });
	});

	it("refuses a persona that cannot be replayed, before rendering", async () => {
		persona.cookies = vi.fn(async () => {
			throw new PersonaFailure("persona-elsewhere");
		});
		expect(await invoke({ deviceId: "pixel-8", path: "/", persona: PERSONA })).toEqual({
			success: false,
			error: "persona-elsewhere",
		});
		expect(capture.fn).not.toHaveBeenCalled();
	});

	it("captures a catalogue device on the server's origin", async () => {
		const result = await invoke({ deviceId: "pixel-8", path: "/cart" });
		expect(result).toEqual({
			success: true,
			data: {
				deviceId: "pixel-8",
				...shot,
				network: "none",
				cpu: "1x",
				orientation: "portrait",
				width: 412,
				height: 915,
				previewSession: false,
				persona: null,
			},
		});
		const [device, url, throttling, options] = capture.fn.mock.calls[0];
		expect(device).toMatchObject({ id: "pixel-8", width: 412 });
		expect(url).toBe("http://localhost:5173/cart");
		expect(throttling).toEqual({ network: { id: "none", conditions: null, loadTimeoutMs: 30_000 }, cpu: { id: "1x", rate: 1 } });
		expect(options).toEqual({ previewSession: false });
	});

	it("turns the device to the named orientation and lends the preview's session when asked", async () => {
		const result = await invoke({ deviceId: "pixel-8", path: "/", orientation: "landscape", previewSession: true });
		expect(result).toMatchObject({
			success: true,
			data: { orientation: "landscape", width: 915, height: 412, previewSession: true },
		});
		const [device, , , options] = capture.fn.mock.calls[0];
		expect(device).toMatchObject({ id: "pixel-8", width: 915, height: 412 });
		expect(options).toEqual({ previewSession: true });
	});

	it("refuses an orientation that is not in the list", async () => {
		expect(await invoke({ deviceId: "pixel-8", path: "/", orientation: "upside-down" })).toEqual({
			success: false,
			error: "invalid-request",
		});
		expect(capture.fn).not.toHaveBeenCalled();
	});

	it("applies the named throttling profiles, never values from the renderer", async () => {
		const result = await invoke({ deviceId: "iphone-15", path: "/", network: "slow-3g", cpu: "4x" });
		expect(result).toMatchObject({ success: true, data: { network: "slow-3g", cpu: "4x", loadMs: 420 } });
		const [, , throttling] = capture.fn.mock.calls[0];
		expect(throttling.network.conditions).toEqual({
			latencyMs: 2000,
			downloadBytesPerSecond: 50_000,
			uploadBytesPerSecond: 50_000,
		});
		expect(throttling.cpu.rate).toBe(4);
	});

	it("refuses a throttling profile that is not in the list", async () => {
		expect(await invoke({ deviceId: "pixel-8", path: "/", network: "offline" })).toEqual({
			success: false,
			error: "unknown-throttling",
		});
		expect(await invoke({ deviceId: "pixel-8", path: "/", cpu: "100x" })).toEqual({
			success: false,
			error: "unknown-throttling",
		});
		expect(capture.fn).not.toHaveBeenCalled();
	});

	it("refuses before rendering anything", async () => {
		expect(await invoke({ path: "/" })).toEqual({ success: false, error: "invalid-request" });
		expect(await invoke({ deviceId: "custom", path: "/" })).toEqual({ success: false, error: "unknown-device" });
		expect(await invoke({ deviceId: "pixel-8", path: "https://evil.example/" })).toEqual({
			success: false,
			error: "invalid-path",
		});
		service.url = null;
		expect(await invoke({ deviceId: "pixel-8", path: "/" })).toEqual({ success: false, error: "not-running" });
		expect(capture.fn).not.toHaveBeenCalled();
	});

	it("runs one capture at a time", async () => {
		let release: (value: unknown) => void = () => undefined;
		capture.fn = vi.fn(() => new Promise((resolve) => (release = resolve)));
		const first = invoke({ deviceId: "pixel-8", path: "/" });
		expect(await invoke({ deviceId: "iphone-15", path: "/" })).toEqual({ success: false, error: "busy" });
		release(shot);
		expect(await first).toMatchObject({ success: true });
		capture.fn = vi.fn(async () => shot);
		expect(await invoke({ deviceId: "iphone-15", path: "/" })).toMatchObject({ success: true });
	});

	it("names a failure, and hides any other error behind capture-failed", async () => {
		capture.fn = vi.fn(async () => {
			throw new DeviceCaptureFailure("load-failed");
		});
		expect(await invoke({ deviceId: "pixel-8", path: "/" })).toEqual({ success: false, error: "load-failed" });
		capture.fn = vi.fn(async () => {
			throw new Error("C:\\Users\\someone\\secret path");
		});
		expect(await invoke({ deviceId: "pixel-8", path: "/" })).toEqual({ success: false, error: "capture-failed" });
	});
});

describe("APP_EMULATOR_SCAN_BREAKPOINTS", () => {
	const scanInvoke = (raw: Record<string, unknown>) =>
		call(IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS, { previewSession: false, persona: null, ...raw });
	const result = { url: "http://localhost:5173/", breakpoints: [768], steps: [] };

	beforeEach(() => {
		service.url = "http://localhost:5173";
		scan.fn = vi.fn(async () => result);
		library.custom = [];
		persona.cookies = vi.fn(async () => [{ name: "sid" }]);
	});

	it("reads the page on the named device, on the server's origin, with the session chosen", async () => {
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "/pricing", previewSession: true })).toEqual({
			success: true,
			data: { deviceId: "desktop-1080p", ...result },
		});
		const [device, url, options] = scan.fn.mock.calls[0];
		expect(device).toMatchObject({ id: "desktop-1080p" });
		expect(url).toBe("http://localhost:5173/pricing");
		expect(options).toEqual({ previewSession: true });
		library.custom = [foldable];
		await scanInvoke({ deviceId: CUSTOM, path: "/", persona: PERSONA });
		expect(scan.fn.mock.calls[1][0]).toMatchObject({ id: CUSTOM });
		expect(scan.fn.mock.calls[1][2]).toEqual({ previewSession: false, persona: [{ name: "sid" }] });
	});

	it("refuses before reading anything", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS, "desktop")).toEqual({
			success: false,
			error: "invalid-request",
		});
		expect(await scanInvoke({ deviceId: "custom-x", path: "/" })).toEqual({ success: false, error: "unknown-device" });
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "//evil.example/" })).toEqual({
			success: false,
			error: "invalid-path",
		});
		service.url = null;
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "/" })).toEqual({ success: false, error: "not-running" });
		expect(scan.fn).not.toHaveBeenCalled();
	});

	it("shares the capture's lock, and names its failures", async () => {
		let release: (value: unknown) => void = () => undefined;
		capture.fn = vi.fn(() => new Promise((resolve) => (release = resolve)));
		const running = invoke({ deviceId: "pixel-8", path: "/" });
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "/" })).toEqual({ success: false, error: "busy" });
		release(shot);
		await running;
		scan.fn = vi.fn(async () => {
			throw new DeviceCaptureFailure("load-failed");
		});
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "/" })).toEqual({ success: false, error: "load-failed" });
		scan.fn = vi.fn(async () => {
			throw new Error("renderer gone");
		});
		expect(await scanInvoke({ deviceId: "desktop-1080p", path: "/" })).toEqual({ success: false, error: "capture-failed" });
	});
});

describe("APP_EMULATOR_EXPORT_DEVICE_GRID", () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

	beforeEach(async () => {
		service.url = "http://localhost:5173";
		library.custom = [];
		exporting.language = "en";
		exporting.dialog = vi.fn(async () => ({ canceled: false, filePath: "/home/someone/Pictures/grid.png" }));
		exporting.compose = vi.fn(async () => png);
		exporting.write = vi.fn(async () => undefined);
		// The main keeps its own last capture of each device.
		capture.fn = vi.fn(async (device: { id: string }) => ({
			...shot,
			image: `data:image/png;base64,${device.id}`,
			report: {
				viewportWidth: 393,
				scrollWidth: 393,
				scanned: 10,
				truncated: false,
				issues: [
					{ kind: "small-text", count: 1, samples: [{ selector: "p.tiny", x: 0, y: 0, width: 393, height: 426 }] },
				],
			},
		}));
		await invoke({ deviceId: "iphone-15", path: "/", network: "fast-3g", cpu: "2x" });
		await invoke({ deviceId: "desktop-1080p", path: "/" });
	});

	it("draws the main's own captures, captioned by the main, and writes where the dialog says", async () => {
		exporting.language = "fr";
		const result = await exportGrid({ deviceIds: ["iphone-15", "ipad-pro", "desktop-1080p"], image: "data:evil" });
		expect(result).toEqual({ success: true, data: { saved: true, fileName: "grid.png" } });
		expect(exporting.dialog).toHaveBeenCalledWith({
			defaultPath: "device-matrix.png",
			filters: [{ name: "PNG", extensions: ["png"] }],
		});
		const [tiles] = exporting.compose.mock.calls[0];
		// ipad-pro was never captured: it is left out.
		expect(tiles).toEqual([
			{
				label: "iPhone 15",
				detail: "393 × 852 @3x · 3G rapide · Processeur 2× plus lent",
				image: "data:image/png;base64,iphone-15",
				aspect: 852 / 393,
				markers: [],
			},
			{
				label: "Ordinateur Full HD",
				detail: "1920 × 1080 @1x",
				image: "data:image/png;base64,desktop-1080p",
				aspect: 1080 / 1920,
				markers: [],
			},
		]);
		expect(exporting.compose.mock.calls[0][1]).toBe("png");
		expect(exporting.write).toHaveBeenCalledWith("/home/someone/Pictures/grid.png", png);
	});

	it("exports a PDF, boxing the faulty elements from the main's own report, in the rendered orientation", async () => {
		await invoke({ deviceId: "iphone-15", path: "/", orientation: "landscape" });
		exporting.dialog = vi.fn(async () => ({ canceled: false, filePath: "/home/someone/grid.pdf" }));
		const result = await exportGrid({ deviceIds: ["iphone-15"], format: "pdf", markers: true });
		expect(result).toEqual({ success: true, data: { saved: true, fileName: "grid.pdf" } });
		expect(exporting.dialog).toHaveBeenCalledWith({
			defaultPath: "device-matrix.pdf",
			filters: [{ name: "PDF", extensions: ["pdf"] }],
		});
		const [tiles, format] = exporting.compose.mock.calls[0];
		expect(format).toBe("pdf");
		expect(tiles[0]).toMatchObject({ detail: "852 × 393 @3x · Landscape", aspect: 393 / 852 });
		expect(tiles[0].markers).toEqual([
			{ kind: "small-text", selector: "p.tiny", x: 0, y: 0, width: 393 / 852, height: 1 },
		]);
	});

	it("exports a custom device under the name the person gave it", async () => {
		library.custom = [foldable];
		await invoke({ deviceId: CUSTOM, path: "/" });
		expect(await exportGrid({ deviceIds: [CUSTOM] })).toMatchObject({ success: true });
		expect(exporting.compose.mock.calls[0][0][0]).toMatchObject({ label: "Flip 6", detail: "360 × 748 @3x" });
		library.custom = [];
		expect(await exportGrid({ deviceIds: [CUSTOM] })).toEqual({ success: false, error: "invalid-request" });
	});

	it("writes nothing when the person cancels the dialog", async () => {
		exporting.dialog = vi.fn(async () => ({ canceled: true, filePath: undefined }));
		expect(await exportGrid({ deviceIds: ["iphone-15"] })).toEqual({ success: true, data: { saved: false } });
		exporting.dialog = vi.fn(async () => ({ canceled: false, filePath: "" }));
		expect(await exportGrid({ deviceIds: ["iphone-15"] })).toEqual({ success: true, data: { saved: false } });
		expect(exporting.compose).not.toHaveBeenCalled();
		expect(exporting.write).not.toHaveBeenCalled();
	});

	it("refuses before opening any dialog", async () => {
		expect(await exportGrid({ deviceIds: ["../grid"] })).toEqual({ success: false, error: "invalid-request" });
		expect(await exportGrid({ deviceIds: ["galaxy-z-fold-5"] })).toEqual({ success: false, error: "nothing-to-export" });
		expect(exporting.dialog).not.toHaveBeenCalled();
	});

	it("names a grid that cannot be built or written, and never runs beside a capture", async () => {
		exporting.compose = vi.fn(async () => {
			throw new Error("canvas lost");
		});
		expect(await exportGrid({ deviceIds: ["iphone-15"] })).toEqual({ success: false, error: "export-failed" });
		exporting.compose = vi.fn(async () => png);
		exporting.write = vi.fn(async () => {
			throw new Error("EACCES: /root/grid.png");
		});
		expect(await exportGrid({ deviceIds: ["iphone-15"] })).toEqual({ success: false, error: "write-failed" });

		let release: (value: unknown) => void = () => undefined;
		capture.fn = vi.fn(() => new Promise((resolve) => (release = resolve)));
		const running = invoke({ deviceId: "pixel-8", path: "/" });
		expect(await exportGrid({ deviceIds: ["iphone-15"] })).toEqual({ success: false, error: "busy" });
		release(shot);
		await running;
	});
});
