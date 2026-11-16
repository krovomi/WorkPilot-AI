/**
 * The recorder's handlers read the renderer's arguments again (S6): an
 * export request outside the closed lists never reaches the exporter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	start: vi.fn(async () => ({ success: true })),
	stop: vi.fn(() => ({ success: true })),
	exportRecording: vi.fn(async () => ({ success: true, code: "x" })),
}));

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn) },
}));
vi.mock("../../browser-recorder/recorder-session", () => ({
	startRecording: state.start,
	stopRecording: state.stop,
}));
vi.mock("../../browser-recorder/recorder-export", () => ({ exportRecording: state.exportRecording }));

import { registerBrowserRecorderHandlers } from "../browser-recorder-handlers";

const call = (channel: string, ...args: unknown[]) => state.handlers.get(channel)?.({}, ...args);
const request = { format: "cypress", destination: "review", name: "Log in", stepIds: ["s1"] };

beforeEach(() => {
	state.handlers.clear();
	vi.clearAllMocks();
	registerBrowserRecorderHandlers();
});

describe("browser recorder handlers", () => {
	it("starts and stops a recording", async () => {
		expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_START, "/p", "http://a.test")).toEqual({ success: true });
		expect(state.start).toHaveBeenCalledWith("/p", "http://a.test");
		expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_STOP)).toEqual({ success: true });
	});

	it("exports a well-formed request only", async () => {
		expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, "/p", request)).toEqual({ success: true, code: "x" });
		expect(state.exportRecording).toHaveBeenCalledWith("/p", request);
		for (const [projectPath, raw] of [
			["/p", { ...request, format: "selenium" }],
			["", request],
			[42, request],
			["/p", null],
		]) {
			expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, projectPath, raw)).toEqual({
				success: false,
				error: "Invalid export request",
			});
		}
		expect(state.exportRecording).toHaveBeenCalledTimes(1);
	});

	it("returns the exporter's failure as a message", async () => {
		state.exportRecording.mockRejectedValueOnce(new Error("no worktree"));
		expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, "/p", request)).toEqual({
			success: false,
			error: "no worktree",
		});
		state.exportRecording.mockRejectedValueOnce("odd");
		expect(await call(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, "/p", request)).toEqual({
			success: false,
			error: "odd",
		});
	});
});
