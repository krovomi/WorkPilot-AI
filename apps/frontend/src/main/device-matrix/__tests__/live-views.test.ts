/**
 * The live views of the device matrix (#383): a device set on a preview
 * `<webview>` through its debugger, reloaded once when its user agent changes,
 * and scroll shares read and written as bounded numbers only.
 */
import { describe, expect, it, vi } from "vitest";
import { findDevicePreset, orientDevice } from "../../../shared/constants/device-presets";
import type { DevicePreset } from "../../../shared/types/device-matrix";
import {
	LiveViewError,
	READ_SCROLL,
	buildScrollTo,
	emulateLiveView,
	readLiveScroll,
	readShare,
	setLiveScroll,
	showsOrigin,
} from "../live-views";

const pixel = findDevicePreset("pixel-8") as DevicePreset;

function guest(overrides: Record<string, unknown> = {}) {
	const commands: { method: string; params?: Record<string, unknown> }[] = [];
	let attached = false;
	const fake = {
		commands,
		userAgent: "Electron",
		debugger: {
			isAttached: () => attached,
			attach: vi.fn(() => {
				attached = true;
			}),
			sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
				commands.push({ method, params });
				return {};
			}),
		},
		getUserAgent: () => fake.userAgent,
		setUserAgent: vi.fn((ua: string) => {
			fake.userAgent = ua;
		}),
		reload: vi.fn(),
		getURL: () => "http://localhost:5173/cart",
		executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ x: 0.25, y: 0.5 })),
		...overrides,
	};
	return fake;
}
type Guest = Parameters<typeof emulateLiveView>[0];

describe("emulateLiveView", () => {
	it("sets the device through the guest's debugger, and reloads once for its user agent", async () => {
		const view = guest();
		const turned = orientDevice(pixel, "landscape");
		expect(await emulateLiveView(view as unknown as Guest, turned)).toEqual({ reloaded: true });
		expect(view.debugger.attach).toHaveBeenCalledWith("1.3");
		expect(view.commands[0]).toMatchObject({
			method: "Emulation.setDeviceMetricsOverride",
			params: { width: 915, height: 412, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } },
		});
		expect(view.commands.map((command) => command.method)).toContain("Emulation.setTouchEmulationEnabled");
		expect(view.setUserAgent).toHaveBeenCalledWith(pixel.userAgent);
		expect(view.reload).toHaveBeenCalledTimes(1);
		expect(await emulateLiveView(view as unknown as Guest, turned)).toEqual({ reloaded: false });
		expect(view.debugger.attach).toHaveBeenCalledTimes(1);
		expect(view.reload).toHaveBeenCalledTimes(1);
	});

	it("names a debugger it cannot use", async () => {
		const view = guest();
		view.debugger.attach = vi.fn(() => {
			throw new Error("Another debugger is already attached");
		});
		const error = await emulateLiveView(view as unknown as Guest, pixel).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(LiveViewError);
		expect(error).toMatchObject({ code: "emulation-failed" });
		expect(view.reload).not.toHaveBeenCalled();
	});
});

describe("scroll shares", () => {
	it("keeps two finite numbers, clamped between 0 and 1", () => {
		expect(readShare({ x: 0.2, y: 1.7, text: "x" })).toEqual({ x: 0.2, y: 1 });
		expect(readShare({ x: -3, y: 0 })).toEqual({ x: 0, y: 0 });
		expect(readShare({ x: Number.NaN, y: 0 })).toBeNull();
		expect(readShare({ x: "0", y: 0 })).toBeNull();
		expect(readShare(null)).toBeNull();
	});

	it("reads and writes them with constant scripts in an isolated world", async () => {
		const view = guest();
		expect(await readLiveScroll(view as unknown as Guest)).toEqual({ x: 0.25, y: 0.5 });
		expect(view.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1384, [{ code: READ_SCROLL }]);
		view.executeJavaScriptInIsolatedWorld = vi.fn(async () => {
			throw new Error("gone");
		});
		expect(await readLiveScroll(view as unknown as Guest)).toBeNull();
		const others = [guest(), guest({ executeJavaScriptInIsolatedWorld: vi.fn(async () => Promise.reject(new Error("gone"))) })];
		await setLiveScroll(others as unknown as Guest[], { x: 0, y: 0.5 });
		expect(others[0].executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1384, [{ code: buildScrollTo({ x: 0, y: 0.5 }) }]);
	});

	it("scrolls a page to a share of what it can scroll, and reads it back", () => {
		const page = { scrollX: 0, scrollY: 0, innerWidth: 400, innerHeight: 800 } as Record<string, number> & {
			scrollTo?: (x: number, y: number) => void;
		};
		page.scrollTo = (x: number, y: number) => {
			page.scrollX = x;
			page.scrollY = y;
		};
		const document = { scrollingElement: { scrollWidth: 400, scrollHeight: 2800 } };
		const run = (code: string) => new Function("window", "document", `return ${code};`)(page, document);
		expect(run(buildScrollTo({ x: 1, y: 0.5 }))).toBe(true);
		expect(page.scrollY).toBe(1000);
		expect(page.scrollX).toBe(0);
		expect(run(READ_SCROLL)).toEqual({ x: 0, y: 0.5 });
		const flat = (code: string) =>
			new Function("window", "document", `return ${code};`)(page, { documentElement: { scrollWidth: 0, scrollHeight: 0 } });
		expect(flat(READ_SCROLL)).toEqual({ x: 0, y: 0 });
	});

	it("tells whether a guest shows a page of an origin", () => {
		expect(showsOrigin(guest() as unknown as Guest, "http://localhost:5173")).toBe(true);
		expect(showsOrigin(guest() as unknown as Guest, "http://localhost:3000")).toBe(false);
		expect(showsOrigin(guest({ getURL: () => "" }) as unknown as Guest, "http://localhost:5173")).toBe(false);
	});
});
