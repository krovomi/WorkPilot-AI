/**
 * The Logs tab of a server card goes to the server: no folder of this computer
 * is read or watched for it.
 */

import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	BrowserWindow: vi.fn(),
}));

vi.mock("../../../../shared/constants", () => ({
	IPC_CHANNELS: {
		TASK_LOGS_GET: "task:logsGet",
		TASK_LOGS_GET_PER_LLM: "task:logsGetPerLlm",
		TASK_LOGS_WATCH: "task:logsWatch",
		TASK_LOGS_UNWATCH: "task:logsUnwatch",
		TASK_LOGS_CHANGED: "task:logsChanged",
		TASK_LOGS_STREAM: "task:logsStream",
	},
	getSpecsDir: vi.fn(() => ".workpilot/specs"),
}));

const getProject = vi.hoisted(() => vi.fn());
vi.mock("../../../project-store", () => ({ projectStore: { getProject } }));

const taskLogService = vi.hoisted(() => ({
	loadLogs: vi.fn(),
	getPerLlmLogs: vi.fn(),
	startWatching: vi.fn(),
	stopWatching: vi.fn(),
	on: vi.fn(),
}));
vi.mock("../../../task-log-service", () => ({ taskLogService }));

const server = vi.hoisted(() => ({
	getServerProject: vi.fn(),
	serverCardLogs: vi.fn(),
	watchServerCardLogs: vi.fn(),
	unwatchServerCardLogs: vi.fn(),
}));
vi.mock("../../../server-projects", () => ({ getServerProject: server.getServerProject }));
vi.mock("../../../server-card-logs", () => ({
	serverCardLogs: server.serverCardLogs,
	watchServerCardLogs: server.watchServerCardLogs,
	unwatchServerCardLogs: server.unwatchServerCardLogs,
}));

import { registerTaskLogsHandlers } from "../logs-handlers";

const SERVER_PROJECT = { id: "p-1", name: "Shop" };

function handler(channel: string) {
	const call = (ipcMain.handle as Mock).mock.calls.find((c) => c[0] === channel);
	if (!call) throw new Error(`no handler for ${channel}`);
	return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("task logs of a server card", () => {
	const send = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		registerTaskLogsHandlers(() => ({ webContents: { send } }) as never);
		server.getServerProject.mockImplementation((id: string) =>
			id === "p-1" ? SERVER_PROJECT : undefined,
		);
	});

	it("reads the log from the server", async () => {
		server.serverCardLogs.mockResolvedValue({ success: true, data: null });
		const result = await handler("task:logsGet")({}, "p-1", "001-a");
		expect(server.serverCardLogs).toHaveBeenCalledWith(SERVER_PROJECT, "001-a");
		expect(result).toEqual({ success: true, data: null });
		expect(getProject).not.toHaveBeenCalled();
		expect(taskLogService.loadLogs).not.toHaveBeenCalled();
	});

	it("has no per-LLM files to offer", async () => {
		expect(await handler("task:logsGetPerLlm")({}, "p-1", "001-a")).toEqual({
			success: true,
			data: [],
		});
		expect(taskLogService.getPerLlmLogs).not.toHaveBeenCalled();
	});

	it("follows the card on the server and forwards each change to the window", async () => {
		await handler("task:logsWatch")({}, "p-1", "001-a");
		expect(taskLogService.startWatching).not.toHaveBeenCalled();
		const [project, cardId, emit] = server.watchServerCardLogs.mock.calls[0];
		expect(project).toBe(SERVER_PROJECT);
		expect(cardId).toBe("001-a");
		emit("001-a", { phases: {} });
		expect(send).toHaveBeenCalledWith("task:logsChanged", "001-a", { phases: {} });
	});

	it("stops following it when the tab closes", async () => {
		await handler("task:logsUnwatch")({}, "001-a");
		expect(server.unwatchServerCardLogs).toHaveBeenCalledWith("001-a");
	});

	it("leaves a local project's logs to this computer", async () => {
		getProject.mockReturnValue(undefined);
		await handler("task:logsGet")({}, "local-1", "001-a");
		expect(server.serverCardLogs).not.toHaveBeenCalled();
		expect(getProject).toHaveBeenCalledWith("local-1");
	});
});
