/**
 * @vitest-environment node
 *
 * The task log channels on a local project, against a real spec folder: a
 * spec id from the renderer that is not a plain name is refused before it
 * becomes a path, a missing spec answers without reading anything, and a
 * failure of the log service comes back as an error instead of a rejection.
 * The service's change and stream events reach the window while it exists.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as { id: string; path: string } | undefined,
	service: null as unknown as import("node:events").EventEmitter & {
		loadLogs: ReturnType<typeof vi.fn>;
		getPerLlmLogs: ReturnType<typeof vi.fn>;
		startWatching: ReturnType<typeof vi.fn>;
		stopWatching: ReturnType<typeof vi.fn>;
	},
	unwatchServer: vi.fn(),
}));

vi.mock("../../../task-log-service", async () => {
	const { EventEmitter: Emitter } = await import("node:events");
	state.service = Object.assign(new Emitter(), {
		loadLogs: vi.fn(),
		getPerLlmLogs: vi.fn(),
		startWatching: vi.fn(),
		stopWatching: vi.fn(),
	});
	return { taskLogService: state.service };
});
vi.mock("../../../project-store", () => ({
	projectStore: { getProject: () => state.project },
}));
vi.mock("../../../server-projects", () => ({ getServerProject: () => undefined }));
vi.mock("../../../server-card-logs", () => ({
	serverCardLogs: vi.fn(),
	watchServerCardLogs: vi.fn(),
	unwatchServerCardLogs: state.unwatchServer,
}));

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerTaskLogsHandlers } from "../logs-handlers";

type Result = { success: boolean; error?: string; data?: unknown };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const SPEC_ID = "003-logs";
const CHANNELS = [
	IPC_CHANNELS.TASK_LOGS_GET,
	IPC_CHANNELS.TASK_LOGS_GET_PER_LLM,
	IPC_CHANNELS.TASK_LOGS_WATCH,
	IPC_CHANNELS.TASK_LOGS_UNWATCH,
];
let root: string;
let specDir: string;
let send: ReturnType<typeof vi.fn>;
let window: BrowserWindow | null;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "logs-handlers-"));
	specDir = path.join(root, ".workpilot", "specs", SPEC_ID);
	mkdirSync(specDir, { recursive: true });
	state.project = { id: "p3", path: root };
	for (const fn of ["loadLogs", "getPerLlmLogs", "startWatching", "stopWatching"] as const) {
		state.service[fn].mockReset();
	}
	state.service.removeAllListeners();
	state.unwatchServer.mockReset();
	send = vi.fn();
	window = { webContents: { send } } as unknown as BrowserWindow;
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	registerTaskLogsHandlers(() => window);
});

afterEach(() => {
	for (const channel of CHANNELS) ipcMain.removeHandler(channel);
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("TASK_LOGS_GET", () => {
	it("loads the logs of the spec folder", async () => {
		const logs = { phases: {} };
		state.service.loadLogs.mockReturnValue(logs);

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET, "p3", SPEC_ID);

		expect(result).toEqual({ success: true, data: logs });
		expect(state.service.loadLogs).toHaveBeenCalledWith(specDir, root, ".workpilot/specs", SPEC_ID);
	});

	it("answers a spec that is not there without reading", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET, "p3", "004-missing");

		expect(result).toEqual({ success: false, error: "Spec directory not found" });
		expect(state.service.loadLogs).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("bad log file"), "bad log file"],
		["boom", "Failed to get task logs"],
	])("turns a service failure into an error: %s", async (thrown, message) => {
		state.service.loadLogs.mockImplementation(() => {
			throw thrown;
		});

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET, "p3", SPEC_ID);

		expect(result).toEqual({ success: false, error: message });
	});
});

describe("TASK_LOGS_GET_PER_LLM", () => {
	it("lists the per-LLM log files", async () => {
		const files = [{ provider: "claude", model: "m" }];
		state.service.getPerLlmLogs.mockReturnValue(files);

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET_PER_LLM, "p3", SPEC_ID);

		expect(result).toEqual({ success: true, data: files });
		expect(state.service.getPerLlmLogs).toHaveBeenCalledWith(
			specDir,
			root,
			".workpilot/specs",
			SPEC_ID,
		);
	});

	it.each([["../escape"], ["a/b"], [""]])("refuses the spec id %j", async (specId) => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET_PER_LLM, "p3", specId);

		expect(result).toEqual({ success: false, error: "Invalid spec ID" });
		expect(state.service.getPerLlmLogs).not.toHaveBeenCalled();
	});

	it("answers an unknown project", async () => {
		state.project = undefined;

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET_PER_LLM, "nope", SPEC_ID);

		expect(result).toEqual({ success: false, error: "Project not found" });
	});

	it("has no files for a spec that is not there yet", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET_PER_LLM, "p3", "004-missing");

		expect(result).toEqual({ success: true, data: [] });
		expect(state.service.getPerLlmLogs).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("unreadable"), "unreadable"],
		[7, "Failed to get per-LLM logs"],
	])("turns a service failure into an error: %s", async (thrown, message) => {
		state.service.getPerLlmLogs.mockImplementation(() => {
			throw thrown;
		});

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_GET_PER_LLM, "p3", SPEC_ID);

		expect(result).toEqual({ success: false, error: message });
	});
});

describe("TASK_LOGS_WATCH", () => {
	it("refuses a spec id that is a path", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_WATCH, "p3", "../../etc");

		expect(result).toEqual({ success: false, error: "Invalid spec ID" });
		expect(state.service.startWatching).not.toHaveBeenCalled();
	});

	it("does not watch a spec that is not there", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_WATCH, "p3", "004-missing");

		expect(result).toEqual({ success: false, error: "Spec directory not found" });
		expect(state.service.startWatching).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("too many watchers"), "too many watchers"],
		[null, "Failed to start watching"],
	])("turns a service failure into an error: %s", async (thrown, message) => {
		state.service.startWatching.mockImplementation(() => {
			throw thrown;
		});

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_WATCH, "p3", SPEC_ID);

		expect(result).toEqual({ success: false, error: message });
	});
});

describe("TASK_LOGS_UNWATCH", () => {
	it("refuses a spec id that is a path", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_LOGS_UNWATCH, "..");

		expect(result).toEqual({ success: false, error: "Invalid spec ID" });
		expect(state.service.stopWatching).not.toHaveBeenCalled();
		expect(state.unwatchServer).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("not watched"), "not watched"],
		[undefined, "Failed to stop watching"],
	])("turns a failure into an error: %s", async (thrown, message) => {
		state.service.stopWatching.mockImplementation(() => {
			throw thrown;
		});

		const result = await invoke(IPC_CHANNELS.TASK_LOGS_UNWATCH, SPEC_ID);

		expect(result).toEqual({ success: false, error: message });
	});
});

describe("log service events", () => {
	it("forwards changes and stream chunks to the window", () => {
		const logs = { phases: {} };
		const chunk = { type: "text", content: "hi" };

		(state.service as EventEmitter).emit("logs-changed", SPEC_ID, logs);
		(state.service as EventEmitter).emit("stream-chunk", SPEC_ID, chunk);

		expect(send.mock.calls).toEqual([
			[IPC_CHANNELS.TASK_LOGS_CHANGED, SPEC_ID, logs],
			[IPC_CHANNELS.TASK_LOGS_STREAM, SPEC_ID, chunk],
		]);
	});

	it("drops them when the window is gone", () => {
		window = null;

		(state.service as EventEmitter).emit("logs-changed", SPEC_ID, {});
		(state.service as EventEmitter).emit("stream-chunk", SPEC_ID, {});

		expect(send).not.toHaveBeenCalled();
	});
});
