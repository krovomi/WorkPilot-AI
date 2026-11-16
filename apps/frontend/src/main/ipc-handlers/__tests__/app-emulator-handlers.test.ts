/**
 * The App Emulator IPC handlers: what the renderer gets back, and which
 * service events reach the window.
 */
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	cleanWorld,
	project,
	realPause,
	resetWorld,
	world,
} from "../../__tests__/app-emulator-world";
import { type AppEmulatorConfig, appEmulatorService } from "../../app-emulator-service";
import { registerAppEmulatorHandlers } from "../app-emulator-handlers";

vi.mock("node:child_process", async () =>
	(await import("../../__tests__/app-emulator-world")).childProcessModule(),
);
vi.mock("../../platform", async () =>
	(await import("../../__tests__/app-emulator-world")).platformModule(),
);

const invoke = (channel: string, ...args: unknown[]) =>
	(
		ipcMain as unknown as {
			invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown>;
		}
	).invokeHandler(channel, {}, ...args);

const send = vi.fn();
let window: { isDestroyed: () => boolean; webContents: { send: typeof send } } | null;

const cliConfig = (projectDir: string): AppEmulatorConfig => ({
	type: "cli",
	framework: "rust",
	startCommand: "cargo run",
	port: 0,
	isWeb: false,
	projectDir,
});

beforeAll(() => {
	registerAppEmulatorHandlers(() => window as unknown as BrowserWindow | null);
});

beforeEach(() => {
	resetWorld();
	send.mockReset();
	window = { isDestroyed: () => false, webContents: { send } };
});

afterEach(async () => {
	vi.useRealTimers();
	appEmulatorService.stopServer();
	await cleanWorld();
});

describe("app emulator handlers", () => {
	it("returns the detected configuration, or why there is none", async () => {
		const dir = project({ "go.mod": "module x" });

		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir })).toEqual({
			success: true,
			data: expect.objectContaining({ framework: "go", projectDir: dir }),
		});
		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: "/nowhere" })).toEqual({
			success: false,
			error: "Project directory not found: /nowhere",
		});
	});

	it("starts once at a time, and a stop lets a new start through", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const dir = project({ "Cargo.toml": "" });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });

		const first = invoke(IPC_CHANNELS.APP_EMULATOR_START, { config: cliConfig(dir) });
		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_START, { config: cliConfig(dir) })).toEqual({
			success: false,
			error: "Already starting — ignoring duplicate request",
		});
		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_STOP)).toEqual({ success: true });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await first).toEqual({ success: true });
		expect(world.spawns).toEqual([]);

		const again = invoke(IPC_CHANNELS.APP_EMULATOR_START, { config: cliConfig(dir) });
		await vi.advanceTimersByTimeAsync(1000);

		expect(await again).toEqual({ success: true });
		expect(world.spawns.map((call) => call.cmd)).toEqual(["cargo"]);
	});

	it("reports a start that failed", async () => {
		const start = vi
			.spyOn(appEmulatorService, "startServer")
			.mockRejectedValueOnce(new Error("did not become ready"))
			.mockRejectedValueOnce("plain failure");
		const dir = project({ "Cargo.toml": "" });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });

		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_START, { config: cliConfig(dir) })).toEqual({
			success: false,
			error: "did not become ready",
		});
		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_START, { config: cliConfig(dir) })).toEqual({
			success: false,
			error: "plain failure",
		});
		start.mockRestore();
	});

	it("reports a detection that failed with something else than an error", async () => {
		const detect = vi
			.spyOn(appEmulatorService, "detectProject")
			.mockRejectedValueOnce("no runner");

		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: "/x" })).toEqual({
			success: false,
			error: "no runner",
		});
		detect.mockRestore();
	});

	it("describes the server that runs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const dir = project({ "Cargo.toml": "" });
		await invoke(IPC_CHANNELS.APP_EMULATOR_DETECT, { projectDir: dir });
		const config = cliConfig(dir);
		const started = invoke(IPC_CHANNELS.APP_EMULATOR_START, { config });
		await vi.advanceTimersByTimeAsync(1000);
		await started;

		expect(await invoke(IPC_CHANNELS.APP_EMULATOR_STATUS)).toEqual({
			success: true,
			data: { running: true, url: null, config },
		});
	});

	it("forwards every service event to the window while it is open", async () => {
		const config = cliConfig("/x");
		appEmulatorService.emit("status", "Starting");
		appEmulatorService.emit("ready", "http://localhost:5173");
		appEmulatorService.emit("output", "line");
		appEmulatorService.emit("error", "boom");
		appEmulatorService.emit("stopped");
		appEmulatorService.emit("config", config);

		expect(send.mock.calls).toEqual([
			[IPC_CHANNELS.APP_EMULATOR_STATUS_UPDATE, "Starting"],
			[IPC_CHANNELS.APP_EMULATOR_READY, "http://localhost:5173"],
			[IPC_CHANNELS.APP_EMULATOR_OUTPUT, "line"],
			[IPC_CHANNELS.APP_EMULATOR_ERROR, "boom"],
			[IPC_CHANNELS.APP_EMULATOR_STOPPED],
			[IPC_CHANNELS.APP_EMULATOR_CONFIG, config],
		]);
	});

	it("sends nothing once the window is gone", async () => {
		window = { isDestroyed: () => true, webContents: { send } };
		appEmulatorService.emit("output", "line");
		window = null;
		appEmulatorService.emit("output", "line");
		await realPause(1);

		expect(send).not.toHaveBeenCalled();
	});
});
