import { EventEmitter } from "node:events";
import type { App, BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
	const { EventEmitter: Emitter } = await import("node:events");
	return { app: new Emitter() };
});

import {
	createRetryBudget,
	guardMainWindow,
	logGpuProcessLoss,
} from "./window-recovery";

function fakeWindow() {
	const contents = Object.assign(new EventEmitter(), {
		reload: vi.fn(),
		loadURL: vi.fn(() => Promise.resolve()),
	});
	let destroyed = false;
	const win = {
		webContents: contents,
		isDestroyed: () => destroyed,
	} as unknown as BrowserWindow;
	return { win, contents, destroy: () => (destroyed = true) };
}

function setup(overrides: Parameters<typeof guardMainWindow>[1] = {}) {
	const { win, contents, destroy } = fakeWindow();
	const log = { warn: vi.fn(), error: vi.fn() };
	const scheduled: Array<() => void> = [];
	const electronApp = new EventEmitter() as unknown as App;
	let clock = 0;
	guardMainWindow(win, {
		log,
		env: {},
		electronApp,
		now: () => clock,
		schedule: (fn) => scheduled.push(fn),
		...overrides,
	});
	const runScheduled = () => {
		for (const fn of scheduled.splice(0)) fn();
	};
	return {
		contents,
		destroy,
		log,
		electronApp,
		runScheduled,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const crash = { reason: "crashed", exitCode: 139 };

describe("createRetryBudget", () => {
	it("allows max attempts per window, then frees them as the window slides", () => {
		let t = 0;
		const take = createRetryBudget(2, 1000, () => t);
		expect(take()).toBe(true);
		expect(take()).toBe(true);
		expect(take()).toBe(false);
		t = 999;
		expect(take()).toBe(false);
		t = 1000;
		expect(take()).toBe(true);
	});
});

describe("guardMainWindow", () => {
	it("reloads the window after its renderer died and logs why", () => {
		const { contents, log, runScheduled } = setup();
		contents.emit("render-process-gone", {}, crash);
		expect(contents.reload).not.toHaveBeenCalled();
		runScheduled();
		expect(contents.reload).toHaveBeenCalledOnce();
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("renderer process gone (crashed, exit code 139)"),
		);
	});

	it("leaves a renderer that exited cleanly alone", () => {
		const { contents, runScheduled } = setup();
		contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
		runScheduled();
		expect(contents.reload).not.toHaveBeenCalled();
	});

	it("loads the page again when the main frame failed to load", () => {
		const { contents, log, runScheduled } = setup();
		contents.emit(
			"did-fail-load",
			{},
			-102,
			"ERR_CONNECTION_REFUSED",
			"http://localhost:5173/",
			true,
		);
		runScheduled();
		expect(contents.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("page failed to load (-102 ERR_CONNECTION_REFUSED)"),
		);
	});

	it("ignores a sub-frame failure and an aborted navigation", () => {
		const { contents, runScheduled } = setup();
		contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://x/", false);
		contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:5173/", true);
		runScheduled();
		expect(contents.loadURL).not.toHaveBeenCalled();
	});

	it("gives up after the budget instead of looping, then recovers once it frees", () => {
		const { contents, log, runScheduled, advance } = setup({
			maxAttempts: 2,
			windowMs: 60_000,
		});
		for (let i = 0; i < 3; i++) contents.emit("render-process-gone", {}, crash);
		runScheduled();
		expect(contents.reload).toHaveBeenCalledTimes(2);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("2 recoveries in 60 s already"),
		);
		advance(60_000);
		contents.emit("render-process-gone", {}, crash);
		runScheduled();
		expect(contents.reload).toHaveBeenCalledTimes(3);
	});

	it("does not touch a window destroyed before the reload", () => {
		const { contents, destroy, runScheduled } = setup();
		contents.emit("render-process-gone", {}, crash);
		destroy();
		runScheduled();
		expect(contents.reload).not.toHaveBeenCalled();
	});

	it("waits retryDelayMs with the default scheduler", () => {
		vi.useFakeTimers();
		try {
			const { win, contents } = fakeWindow();
			guardMainWindow(win, {
				log: { warn: vi.fn(), error: vi.fn() },
				env: {},
				electronApp: new EventEmitter() as unknown as App,
				retryDelayMs: 500,
			});
			contents.emit("render-process-gone", {}, crash);
			vi.advanceTimersByTime(499);
			expect(contents.reload).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(contents.reload).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does nothing in the smoke test, where a lost renderer is the failure", () => {
		const { contents, electronApp, runScheduled } = setup({
			env: { WORKPILOT_SMOKE_TEST: "1" },
		});
		contents.emit("render-process-gone", {}, crash);
		runScheduled();
		expect(contents.reload).not.toHaveBeenCalled();
		expect((electronApp as unknown as EventEmitter).listenerCount("child-process-gone")).toBe(0);
	});

	it("uses Electron's app when none is given", async () => {
		const { app } = await import("electron");
		const { win } = fakeWindow();
		guardMainWindow(win, { log: { warn: vi.fn(), error: vi.fn() }, env: {} });
		expect((app as unknown as EventEmitter).listenerCount("child-process-gone")).toBe(1);
	});
});

describe("logGpuProcessLoss", () => {
	it("logs a GPU process loss, once per app however many windows are guarded", () => {
		const { electronApp, log } = setup();
		logGpuProcessLoss(electronApp, log);
		const emitter = electronApp as unknown as EventEmitter;
		expect(emitter.listenerCount("child-process-gone")).toBe(1);
		emitter.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 8704 });
		expect(log.warn).toHaveBeenCalledWith(
			"[window-recovery] GPU process gone (crashed, exit code 8704)",
		);
	});

	it("ignores other child processes and a clean GPU exit", () => {
		const { electronApp, log } = setup();
		const emitter = electronApp as unknown as EventEmitter;
		emitter.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
		emitter.emit("child-process-gone", {}, { type: "GPU", reason: "clean-exit", exitCode: 0 });
		expect(log.warn).not.toHaveBeenCalled();
	});
});
