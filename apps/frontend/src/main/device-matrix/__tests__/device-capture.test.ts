/**
 * Capturing one device of the matrix (#383): a hidden, sandboxed window on an
 * in-memory session that grants nothing, the device emulated before the page
 * loads, no way off the server's origin, and the window always destroyed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	windows: [] as FakeWindow[],
	session: null as null | FakeSession,
	loadURL: (() => Promise.resolve()) as (url: string) => Promise<void>,
	screenshot: { data: "iVBORw0KGgo=" } as unknown,
	probe: (() => Promise.resolve({ issues: [], viewportWidth: 393, scrollWidth: 393 })) as () => Promise<unknown>,
	shownUrl: "http://localhost:5173/account",
	attachThrows: false,
	detachThrows: false,
}));

interface FakeSession {
	setPermissionRequestHandler: ReturnType<typeof vi.fn>;
	setPermissionCheckHandler: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	clearStorageData: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
	options: Record<string, unknown>;
	destroy: ReturnType<typeof vi.fn>;
	listeners: Record<string, (event: { preventDefault: () => void }, target: string) => void>;
	openHandler?: () => unknown;
	commands: { method: string; params?: Record<string, unknown> }[];
	userAgent?: string;
	probeCode?: string;
	attached: boolean;
}

vi.mock("electron", () => {
	class BrowserWindow {
		webContents: Record<string, unknown>;
		destroy = vi.fn();
		constructor(options: Record<string, unknown>) {
			const record: FakeWindow = {
				options,
				destroy: this.destroy,
				listeners: {},
				commands: [],
				attached: false,
			};
			state.windows.push(record);
			this.webContents = {
				setWindowOpenHandler: (handler: () => unknown) => {
					record.openHandler = handler;
				},
				on: (name: string, listener: FakeWindow["listeners"][string]) => {
					record.listeners[name] = listener;
				},
				setUserAgent: (ua: string) => {
					record.userAgent = ua;
				},
				loadURL: (url: string) => state.loadURL(url),
				getURL: () => state.shownUrl,
				executeJavaScriptInIsolatedWorld: (_world: number, scripts: { code: string }[]) => {
					record.probeCode = scripts[0].code;
					return state.probe();
				},
				debugger: {
					attach: () => {
						if (state.attachThrows) throw new Error("attached elsewhere");
						record.attached = true;
					},
					isAttached: () => record.attached,
					detach: () => {
						if (state.detachThrows) throw new Error("gone");
						record.attached = false;
					},
					sendCommand: async (method: string, params?: Record<string, unknown>) => {
						record.commands.push({ method, params });
						return method === "Page.captureScreenshot" ? state.screenshot : {};
					},
				},
			};
		}
	}
	const fakeSession: FakeSession = {
		setPermissionRequestHandler: vi.fn(),
		setPermissionCheckHandler: vi.fn(),
		on: vi.fn(),
		clearStorageData: vi.fn(() => Promise.resolve()),
	};
	state.session = fakeSession;
	return { BrowserWindow, session: { fromPartition: vi.fn(() => fakeSession) } };
});

import { findDevicePreset } from "../../../shared/constants/device-presets";
import { DeviceCaptureFailure, LOAD_TIMEOUT_MS, MAX_IMAGE_CHARS, SETTLE_MS, captureDevice } from "../device-capture";

const iphone = findDevicePreset("iphone-15");
const desktop = findDevicePreset("desktop-1080p");
if (!iphone || !desktop) throw new Error("presets missing");

async function run(device = iphone, url = "http://localhost:5173/account") {
	const done = captureDevice(device as NonNullable<typeof iphone>, url);
	// Observed now: a refusal may settle before the settle delay runs out.
	done.catch(() => undefined);
	await vi.advanceTimersByTimeAsync(SETTLE_MS);
	return done;
}

const lastWindow = () => state.windows[state.windows.length - 1];

describe("captureDevice", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		state.windows = [];
		state.loadURL = () => Promise.resolve();
		state.screenshot = { data: "iVBORw0KGgo=" };
		state.probe = () => Promise.resolve({ issues: [], viewportWidth: 393, scrollWidth: 393 });
		state.shownUrl = "http://localhost:5173/account";
		state.attachThrows = false;
		state.detachThrows = false;
	});

	it("renders in a hidden sandboxed window that grants nothing", async () => {
		const shot = await run();
		const window = lastWindow();
		expect(window.options).toMatchObject({ show: false, width: 393, height: 852 });
		expect(window.options.webPreferences).toMatchObject({
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
		});
		expect(window.options.webPreferences).not.toHaveProperty("preload");
		const session = state.session as FakeSession;
		const request = session.setPermissionRequestHandler.mock.calls[0][0];
		const answer = vi.fn();
		request(null, "media", answer);
		expect(answer).toHaveBeenCalledWith(false);
		expect(session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
		const download = { preventDefault: vi.fn() };
		session.on.mock.calls[0][1](download);
		expect(download.preventDefault).toHaveBeenCalled();
		expect(window.openHandler?.()).toEqual({ action: "deny" });
		expect(shot).toEqual({
			url: "http://localhost:5173/account",
			image: "data:image/png;base64,iVBORw0KGgo=",
			report: { viewportWidth: 393, scrollWidth: 393, scanned: 0, truncated: false, issues: [] },
		});
		expect(window.destroy).toHaveBeenCalled();
		expect(session.clearStorageData).toHaveBeenCalled();
	});

	it("emulates the device before loading, and reads it in an isolated world", async () => {
		await run();
		const window = lastWindow();
		const methods = window.commands.map((command) => command.method);
		expect(methods).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
			"Page.captureScreenshot",
		]);
		expect(window.commands[0].params).toMatchObject({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
		expect(window.commands[1].params).toEqual({ enabled: true, maxTouchPoints: 5 });
		expect(window.userAgent).toContain("iPhone");
		expect(window.probeCode).toContain('"touch":true');
	});

	it("emulates no touch on a desktop and guards the session only once", async () => {
		const guard = (state.session as FakeSession).setPermissionRequestHandler;
		const before = guard.mock.calls.length;
		await run(desktop);
		expect(lastWindow().commands[1].params).toEqual({ enabled: false, maxTouchPoints: 0 });
		expect(guard.mock.calls.length).toBe(before);
	});

	it("never leaves the server's origin", async () => {
		await run();
		const { listeners } = lastWindow();
		for (const name of ["will-navigate", "will-redirect"]) {
			const away = { preventDefault: vi.fn() };
			listeners[name](away, "https://evil.example/");
			expect(away.preventDefault).toHaveBeenCalled();
			const garbage = { preventDefault: vi.fn() };
			listeners[name](garbage, "not a url");
			expect(garbage.preventDefault).toHaveBeenCalled();
			const stay = { preventDefault: vi.fn() };
			listeners[name](stay, "http://localhost:5173/next");
			expect(stay.preventDefault).not.toHaveBeenCalled();
		}
	});

	it("does not fail a capture when the session cannot be cleared", async () => {
		const session = state.session as FakeSession;
		session.clearStorageData.mockImplementationOnce(() => Promise.reject(new Error("busy")));
		expect((await run()).image).toMatch(/^data:image\/png;base64,/);
	});

	it("reports the requested address when the shown one is elsewhere", async () => {
		state.shownUrl = "chrome-error://chromewebdata/";
		expect((await run()).url).toBe("http://localhost:5173/account");
	});

	it("keeps the capture when the page cannot be read", async () => {
		state.probe = () => Promise.reject(new Error("world gone"));
		expect((await run()).report).toBeNull();
	});

	it("names a page that fails or never loads", async () => {
		state.loadURL = () => Promise.reject(new Error("ERR_CONNECTION_REFUSED"));
		await expect(run()).rejects.toEqual(new DeviceCaptureFailure("load-failed"));
		expect(lastWindow().destroy).toHaveBeenCalled();

		state.loadURL = () => new Promise(() => undefined);
		const pending = captureDevice(iphone, "http://localhost:5173/");
		const settled = expect(pending).rejects.toMatchObject({ code: "load-failed" });
		await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
		await settled;
	});

	it("refuses an empty, missing or oversized image", async () => {
		for (const screenshot of [{ data: "" }, {}, undefined, { data: "x".repeat(MAX_IMAGE_CHARS + 1) }]) {
			state.screenshot = screenshot;
			await expect(run()).rejects.toMatchObject({ code: "capture-failed" });
		}
	});

	it("destroys the window even when the debugger cannot attach or detach", async () => {
		state.attachThrows = true;
		await expect(run()).rejects.toThrow("attached elsewhere");
		expect(lastWindow().destroy).toHaveBeenCalled();
		state.attachThrows = false;
		state.detachThrows = true;
		await run();
		expect(lastWindow().destroy).toHaveBeenCalled();
	});
});
