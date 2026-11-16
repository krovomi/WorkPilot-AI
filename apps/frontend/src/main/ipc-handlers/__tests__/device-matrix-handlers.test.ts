/**
 * The device matrix channel (#383): the renderer names a catalogue device and
 * a path; the origin is always the emulator's own server, a path that leaves
 * it is refused, and only one capture runs at a time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());
const service = vi.hoisted(() => ({ url: "http://localhost:5173" as string | null }));
const capture = vi.hoisted(() => ({ fn: vi.fn() }));

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

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { DeviceCaptureFailure } from "../../device-matrix/device-capture";
import { readCaptureRequest, registerDeviceMatrixHandlers, resolveCaptureUrl } from "../device-matrix-handlers";

registerDeviceMatrixHandlers();
const invoke = (raw: unknown) => {
	const handler = handlers.get(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE);
	if (!handler) throw new Error("handler not registered");
	return handler({}, raw);
};

const shot = { url: "http://localhost:5173/cart", image: "data:image/png;base64,AA==", report: null };

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
	it("keeps only a device id and a path, both strings", () => {
		expect(readCaptureRequest({ deviceId: "pixel-8", path: "/", url: "https://evil.example" })).toEqual({
			deviceId: "pixel-8",
			path: "/",
		});
		expect(readCaptureRequest(null)).toBeNull();
		expect(readCaptureRequest("pixel-8")).toBeNull();
		expect(readCaptureRequest({ deviceId: 8, path: "/" })).toBeNull();
		expect(readCaptureRequest({ deviceId: "pixel-8", path: ["/"] })).toBeNull();
	});
});

describe("APP_EMULATOR_CAPTURE_DEVICE", () => {
	beforeEach(() => {
		service.url = "http://localhost:5173";
		capture.fn = vi.fn(async () => shot);
	});

	it("captures a catalogue device on the server's origin", async () => {
		const result = await invoke({ deviceId: "pixel-8", path: "/cart" });
		expect(result).toEqual({ success: true, data: { deviceId: "pixel-8", ...shot } });
		const [device, url] = capture.fn.mock.calls[0];
		expect(device).toMatchObject({ id: "pixel-8", width: 412 });
		expect(url).toBe("http://localhost:5173/cart");
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
