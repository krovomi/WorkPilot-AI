/**
 * The live view channels (#383): the renderer names a `<webview>` by id, and
 * the main only acts on a guest of the asking window that shows a page of
 * the emulator's server; the device is a known id, the orientation a name,
 * the scroll two bounded numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>());
const service = vi.hoisted(() => ({ url: "http://localhost:5173" as string | null }));
const guests = vi.hoisted(() => new Map<number, { id: number; url: string }>());
const live = vi.hoisted(() => ({ emulate: vi.fn(), read: vi.fn(), set: vi.fn() }));

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
}));
vi.mock("../../app-emulator-service", () => ({ appEmulatorService: { getUrl: () => service.url } }));
vi.mock("../../preview-point", () => ({
	resolvePreview: (sender: { id: number }, id: unknown) => {
		const guest = typeof id === "number" ? guests.get(id) : undefined;
		return guest && sender.id === 1 ? { ...guest, getURL: () => guest.url } : null;
	},
}));
vi.mock("../../device-matrix/custom-devices", async () => {
	const { findDevicePreset } = await import("../../../shared/constants/device-presets");
	return { findDevice: async (id: unknown) => findDevicePreset(id) };
});
vi.mock("../../device-matrix/live-views", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../device-matrix/live-views")>();
	return {
		...actual,
		emulateLiveView: (...args: unknown[]) => live.emulate(...args),
		readLiveScroll: (...args: unknown[]) => live.read(...args),
		setLiveScroll: (...args: unknown[]) => live.set(...args),
	};
});

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { LiveViewError } from "../../device-matrix/live-views";
import { registerLiveViewHandlers } from "../live-view-handlers";

registerLiveViewHandlers();
const app = { sender: { id: 1 } };
const call = (channel: string, raw: unknown, event: unknown = app) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error("handler not registered");
	return handler(event, raw);
};
const emulate = (raw: Record<string, unknown>, event?: unknown) =>
	call(IPC_CHANNELS.APP_EMULATOR_EMULATE_LIVE_VIEW, { webContentsId: 7, deviceId: "pixel-8", orientation: "portrait", ...raw }, event);

beforeEach(() => {
	service.url = "http://localhost:5173";
	guests.clear();
	guests.set(7, { id: 7, url: "http://localhost:5173/cart" });
	guests.set(8, { id: 8, url: "http://localhost:5173/" });
	guests.set(9, { id: 9, url: "https://elsewhere.example/" });
	live.emulate = vi.fn(async () => ({ reloaded: true }));
	live.read = vi.fn(async () => ({ x: 0, y: 0.4 }));
	live.set = vi.fn(async () => undefined);
});

describe("APP_EMULATOR_EMULATE_LIVE_VIEW", () => {
	it("emulates a known device, turned as named, in a guest of this window on the server", async () => {
		expect(await emulate({ orientation: "landscape" })).toEqual({ success: true, data: { reloaded: true } });
		const [guest, device] = live.emulate.mock.calls[0];
		expect(guest).toMatchObject({ id: 7 });
		expect(device).toMatchObject({ id: "pixel-8", width: 915, height: 412 });
	});

	it("refuses anything else before touching a guest", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_EMULATE_LIVE_VIEW, null)).toEqual({ success: false, error: "invalid-request" });
		expect(await emulate({ orientation: "sideways" })).toEqual({ success: false, error: "invalid-request" });
		expect(await emulate({ deviceId: 3 })).toEqual({ success: false, error: "invalid-request" });
		expect(await emulate({ deviceId: "made-up" })).toEqual({ success: false, error: "unknown-device" });
		expect(await emulate({ webContentsId: 99 })).toEqual({ success: false, error: "unknown-view" });
		expect(await emulate({}, { sender: { id: 2 } })).toEqual({ success: false, error: "unknown-view" });
		expect(await emulate({ webContentsId: 9 })).toEqual({ success: false, error: "elsewhere" });
		service.url = null;
		expect(await emulate({})).toEqual({ success: false, error: "not-running" });
		service.url = "file:///etc";
		expect(await emulate({})).toEqual({ success: false, error: "not-running" });
		expect(live.emulate).not.toHaveBeenCalled();
	});

	it("names a failed emulation", async () => {
		live.emulate = vi.fn(async () => {
			throw new LiveViewError("emulation-failed");
		});
		expect(await emulate({})).toEqual({ success: false, error: "emulation-failed" });
		live.emulate = vi.fn(async () => {
			throw new Error("internal detail");
		});
		expect(await emulate({})).toEqual({ success: false, error: "emulation-failed" });
	});
});

describe("live scroll channels", () => {
	it("reads the share of a live view, and names one that does not answer", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_READ_LIVE_SCROLL, { webContentsId: 7 })).toEqual({
			success: true,
			data: { x: 0, y: 0.4 },
		});
		live.read = vi.fn(async () => null);
		expect(await call(IPC_CHANNELS.APP_EMULATOR_READ_LIVE_SCROLL, { webContentsId: 7 })).toEqual({
			success: false,
			error: "unknown-view",
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_READ_LIVE_SCROLL, { webContentsId: 9 })).toEqual({
			success: false,
			error: "elsewhere",
		});
	});

	it("scrolls the named views, once each, to a bounded share", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SET_LIVE_SCROLL, { webContentsIds: [7, 8, 7], x: 0, y: 2 })).toEqual({
			success: true,
			data: { x: 0, y: 1 },
		});
		const [targets, share] = live.set.mock.calls[0];
		expect(targets.map((guest: { id: number }) => guest.id)).toEqual([7, 8]);
		expect(share).toEqual({ x: 0, y: 1 });
	});

	it("refuses a list it cannot check, and scrolls nothing when one view is not the matrix's", async () => {
		for (const raw of [
			{ webContentsIds: [], x: 0, y: 0 },
			{ webContentsIds: "7", x: 0, y: 0 },
			{ webContentsIds: [7, 8, 7, 8, 7, 8, 7], x: 0, y: 0 },
			{ webContentsIds: [7], x: "0", y: 0 },
		]) {
			expect(await call(IPC_CHANNELS.APP_EMULATOR_SET_LIVE_SCROLL, raw)).toEqual({ success: false, error: "invalid-request" });
		}
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SET_LIVE_SCROLL, { webContentsIds: [7, 9], x: 0, y: 0 })).toEqual({
			success: false,
			error: "elsewhere",
		});
		expect(live.set).not.toHaveBeenCalled();
	});
});
