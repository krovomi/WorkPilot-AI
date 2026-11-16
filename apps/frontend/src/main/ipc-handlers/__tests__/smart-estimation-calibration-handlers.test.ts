/**
 * The calibration handlers: what the renderer sends is checked in the main
 * process (a known project id, a category of the closed list, whole scores
 * from 1 to 13) before the runner is spawned, without a shell.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	spawn: vi.fn(),
	getProject: vi.fn(),
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
}));

vi.mock("electron", () => ({
	app: mocks.app,
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../project-store", () => ({ projectStore: { getProject: mocks.getProject } }));
vi.mock("../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, ["-u"]],
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async () => ({ PATH: "/usr/bin" }),
}));

import path from "node:path";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	adjustArgs,
	parseRunnerOutput,
	projectPathFor,
	registerSmartEstimationCalibrationHandlers,
	resetArgs,
	runCalibrationRunner,
} from "../smart-estimation-calibration-handlers";

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	return child;
}

const SUMMARY = { samples: 2, adjustments: 1, reset_at: null };

beforeEach(() => {
	mocks.handlers.clear();
	mocks.spawn.mockReset();
	mocks.getProject.mockReset();
	mocks.getProject.mockImplementation((id: string) =>
		id === "p1" ? { id: "p1", path: "/projects/one" } : undefined,
	);
	mocks.app.isPackaged = false;
	registerSmartEstimationCalibrationHandlers();
});

describe("argument checks", () => {
	it("resolves the project path from its id, never from the renderer", () => {
		expect(projectPathFor("p1")).toBe("/projects/one");
		expect(() => projectPathFor("/etc")).toThrow("Unknown project");
		expect(() => projectPathFor(42)).toThrow("Unknown project");
	});

	it("builds an adjustment from checked values only", () => {
		expect(
			adjustArgs({
				projectId: "p1",
				category: "infra",
				baseScore: 5,
				adjustedScore: 8,
				command: "rm -rf /",
			}),
		).toEqual([
			"--project-path",
			"/projects/one",
			"--action",
			"adjust",
			"--category",
			"infra",
			"--base-score",
			"5",
			"--adjusted-score",
			"8",
		]);
	});

	it("refuses a hostile or malformed adjustment", () => {
		const ok = { projectId: "p1", category: "infra", baseScore: 5, adjustedScore: 8 };
		expect(() => adjustArgs(null)).toThrow("Invalid adjustment");
		expect(() => adjustArgs("x")).toThrow("Invalid adjustment");
		expect(() => adjustArgs({ ...ok, category: "--action=reset" })).toThrow("category");
		expect(() => adjustArgs({ ...ok, baseScore: 0 })).toThrow("1 to 13");
		expect(() => adjustArgs({ ...ok, adjustedScore: 14 })).toThrow("1 to 13");
		expect(() => adjustArgs({ ...ok, adjustedScore: 2.5 })).toThrow("1 to 13");
		expect(() => adjustArgs({ ...ok, baseScore: "5" })).toThrow("1 to 13");
		expect(() => adjustArgs({ ...ok, projectId: "../other" })).toThrow("Unknown project");
	});

	it("builds a reset for a known project only", () => {
		expect(resetArgs({ projectId: "p1" })).toEqual([
			"--project-path",
			"/projects/one",
			"--action",
			"reset",
		]);
		expect(() => resetArgs(undefined)).toThrow("Unknown project");
	});
});

describe("parseRunnerOutput", () => {
	it("reads the summary of a successful run", () => {
		const out = `noise\nESTIMATION_CALIBRATION_RESULT:${JSON.stringify(SUMMARY)}\n`;
		expect(parseRunnerOutput(out, 0)).toEqual(SUMMARY);
	});

	it("reports the runner's error, or the exit code", () => {
		expect(() =>
			parseRunnerOutput("ESTIMATION_CALIBRATION_ERROR:project path not found\n", 1),
		).toThrow("project path not found");
		expect(() =>
			parseRunnerOutput(`ESTIMATION_CALIBRATION_RESULT:${JSON.stringify(SUMMARY)}`, 2),
		).toThrow("exited with code 2");
	});
});

describe("runCalibrationRunner", () => {
	it("spawns the runner from the backend folder with an argument list", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const running = runCalibrationRunner(["--action", "reset"]);
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		child.stdout.emit(
			"data",
			Buffer.from(`ESTIMATION_CALIBRATION_RESULT:${JSON.stringify(SUMMARY)}\n`),
		);
		child.emit("close", 0);
		await expect(running).resolves.toEqual(SUMMARY);

		const backend = path.resolve("/app/frontend", "..", "backend");
		const [command, args, options] = mocks.spawn.mock.calls[0];
		expect(command).toBe("python3");
		expect(args).toEqual([
			"-u",
			path.join(backend, "runners", "estimation_calibration_runner.py"),
			"--action",
			"reset",
		]);
		expect(options).toEqual({ cwd: backend, env: { PATH: "/usr/bin" } });
		expect(options).not.toHaveProperty("shell");
	});

	it("uses the bundled backend once packaged", async () => {
		mocks.app.isPackaged = true;
		const resources = "/opt/app/resources";
		Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const running = runCalibrationRunner([]);
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		child.emit("close", 1);
		await expect(running).rejects.toThrow("exited with code 1");
		expect(mocks.spawn.mock.calls[0][2].cwd).toBe(path.resolve(resources, "backend"));
	});

	it("rejects when the interpreter cannot start", async () => {
		const child = fakeChild();
		mocks.spawn.mockReturnValue(child);
		const running = runCalibrationRunner([]);
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		child.emit("error", new Error("ENOENT"));
		await expect(running).rejects.toThrow("ENOENT");
	});
});

describe("registered handlers", () => {
	it("refuses a hostile adjustment without spawning anything", async () => {
		const handler = mocks.handlers.get(IPC_CHANNELS.SMART_ESTIMATION_ADJUST);
		await expect(
			handler?.({}, { projectId: "p1", category: "$(id)", baseScore: 1, adjustedScore: 2 }),
		).rejects.toThrow("category");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("runs an adjustment and a reset", async () => {
		mocks.spawn.mockImplementation(() => {
			const child = fakeChild();
			setTimeout(() => {
				child.stdout.emit(
					"data",
					Buffer.from(`ESTIMATION_CALIBRATION_RESULT:${JSON.stringify(SUMMARY)}\n`),
				);
				child.emit("close", 0);
			}, 0);
			return child;
		});
		const adjust = mocks.handlers.get(IPC_CHANNELS.SMART_ESTIMATION_ADJUST);
		const reset = mocks.handlers.get(IPC_CHANNELS.SMART_ESTIMATION_RESET_CALIBRATION);
		await expect(
			adjust?.({}, { projectId: "p1", category: "backend", baseScore: 3, adjustedScore: 4 }),
		).resolves.toEqual(SUMMARY);
		await expect(reset?.({}, { projectId: "p1" })).resolves.toEqual(SUMMARY);
		expect(mocks.spawn.mock.calls[1][1]).toContain("reset");
	});
});
