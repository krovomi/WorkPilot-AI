/**
 * Express lane: the runner starts once per local project, only while the
 * setting is on and the approval tiers enforce; what it prints is folded into
 * one outcome, and a project the lane must not touch is never given to it.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

const { spawnMock, pythonPath, stored } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	pythonPath: { current: "/py/bin/python" as string | null },
	stored: { projects: [] as unknown[] },
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));
vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
}));
vi.mock("../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("../project-store", () => ({ projectStore: { getProjects: () => stored.projects } }));
vi.mock("../ipc-handlers/task/split-merge-watch", () => ({ offlineStrict: () => false }));
vi.mock("../settings-utils", () => ({ readSettingsFile: () => undefined }));
vi.mock("../utils/ensure-python", () => ({ readyPythonPath: async () => pythonPath.current }));
vi.mock("../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, ["-I"]],
}));
vi.mock("../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (_backend: string, options: { extra?: Record<string, string> }) => ({
		PYTHONPATH: "/backend",
		...options.extra,
	}),
}));

import { app } from "electron";
import { appLog } from "../app-logger";
import {
	type ExpressLaneDeps,
	expressLaneEnabled,
	expressLanePass,
	laneProjects,
	parseRunnerOutput,
	runExpressLane,
	startExpressLane,
	stopExpressLane,
} from "../express-lane";

const project = (id: string, extra: Partial<Project> = {}): Project =>
	({ id, name: id, path: `/projects/${id}`, ...extra }) as Project;

const ON = { expressLane: true, approvalTiers: "enforce" };

describe("expressLaneEnabled", () => {
	it("needs the switch on and the tiers enforcing", () => {
		expect(expressLaneEnabled(ON)).toBe(true);
		expect(expressLaneEnabled({ ...ON, approvalTiers: "observe" })).toBe(false);
		expect(expressLaneEnabled({ ...ON, approvalTiers: "always" })).toBe(false);
		expect(expressLaneEnabled({ approvalTiers: "enforce" })).toBe(false);
		expect(expressLaneEnabled({ ...ON, expressLane: "true" })).toBe(false);
		expect(expressLaneEnabled(undefined)).toBe(false);
	});
});

describe("parseRunnerOutput", () => {
	it("keeps the counts of the result line and ignores the rest", () => {
		const out = [
			'{"pr": 3, "merged": true}',
			"not json",
			"null",
			'"text"',
			'{"result": {"seen": 2, "merged": 1}}',
			"",
		].join("\n");
		expect(parseRunnerOutput(out)).toEqual({ seen: 2, merged: 1 });
	});

	it("reads an error, a skip and odd counts", () => {
		expect(parseRunnerOutput('{"error": "not a worktree"}')).toEqual({
			seen: 0,
			merged: 0,
			error: "not a worktree",
		});
		expect(
			parseRunnerOutput('{"result": {"skipped": "approval tiers are off", "seen": -1, "merged": 1.5}}'),
		).toEqual({ seen: 0, merged: 0, skipped: "approval tiers are off" });
		expect(parseRunnerOutput('{"result": {"error": "HTTP 401"}}').error).toBe("HTTP 401");
		expect(parseRunnerOutput(`{"error": "${"x".repeat(400)}"}`).error).toHaveLength(300);
	});

	it("says so when the runner stopped without a result", () => {
		expect(parseRunnerOutput('{"pr": 1}\n{"error": ""}').error).toBe(
			"the express lane stopped without a result",
		);
	});
});

describe("laneProjects", () => {
	it("leaves out server projects, offline ones and those without a folder", () => {
		const list = [
			project("a"),
			project("b", { remote: { serverUrl: "https://s" } } as unknown as Partial<Project>),
			project("c"),
			project("d", { path: "" }),
		];
		const offline = (p: string) => p === "/projects/c";
		expect(laneProjects(list, offline).map((p) => p.id)).toEqual(["a"]);
	});
});

describe("expressLanePass", () => {
	let deps: ExpressLaneDeps & { run: ReturnType<typeof vi.fn> };
	beforeEach(() => {
		vi.mocked(appLog.info).mockClear();
		vi.mocked(appLog.warn).mockClear();
		deps = {
			settings: () => ON,
			projects: () => [project("a"), project("b")],
			offline: () => false,
			run: vi.fn(async () => ({ seen: 2, merged: 1 })),
		};
	});

	it("runs each project in turn and counts the merges", async () => {
		expect(await expressLanePass(deps)).toBe(2);
		expect(deps.run.mock.calls.map(([p]) => p.id)).toEqual(["a", "b"]);
		expect(deps.run.mock.calls[0][1]).toBe(ON);
		expect(appLog.info).toHaveBeenCalledWith("[EXPRESS] a: 1 of 2 dependency PRs merged");
	});

	it("starts nothing when the lane is off or the tiers observe", async () => {
		for (const settings of [undefined, { ...ON, expressLane: false }, { ...ON, approvalTiers: "observe" }]) {
			deps.settings = () => settings;
			expect(await expressLanePass(deps)).toBe(0);
		}
		expect(deps.run).not.toHaveBeenCalled();
	});

	it("logs a failing project and goes on with the next", async () => {
		deps.run
			.mockRejectedValueOnce(new Error("spawn EACCES"))
			.mockResolvedValueOnce({ seen: 0, merged: 0, error: "HTTP 401" });
		deps.projects = () => [project("a"), project("b"), project("c")];
		expect(await expressLanePass(deps)).toBe(1);
		expect(appLog.warn).toHaveBeenCalledWith("[EXPRESS] a: spawn EACCES");
		expect(appLog.warn).toHaveBeenCalledWith("[EXPRESS] b: HTTP 401");
	});

	it("reports a thrown value that is not an error, and stays quiet when nothing was seen", async () => {
		deps.run.mockRejectedValueOnce("boom").mockResolvedValueOnce({ seen: 0, merged: 0 });
		await expressLanePass(deps);
		expect(appLog.warn).toHaveBeenCalledWith("[EXPRESS] a: boom");
		expect(appLog.info).not.toHaveBeenCalled();
	});
});

const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();
}

describe("runExpressLane", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		pythonPath.current = "/py/bin/python";
	});

	it("starts the runner with an argument list, the tier in its env, and reads its result", async () => {
		const child = new FakeChild();
		spawnMock.mockReturnValue(child);
		const done = runExpressLane(project("a"), ON);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
		const [command, args, options] = spawnMock.mock.calls[0];
		expect(command).toBe("/py/bin/python");
		expect(args[0]).toBe("-I");
		expect(args[1].replaceAll("\\", "/")).toMatch(/backend\/runners\/express_lane_runner\.py$/);
		expect(args.slice(2)).toEqual(["--project-dir", "/projects/a"]);
		expect(options.env).toMatchObject({ WORKPILOT_APPROVALS: "enforce", WORKPILOT_CLAUDE_SHIP: "0" });
		expect(options.shell).toBeUndefined();
		child.stderr.emit("data", Buffer.from("trace\n"));
		child.stdout.emit("data", Buffer.from('{"pr": 1}\n{"result": {"seen"'));
		child.stdout.emit("data", Buffer.from(': 1, "merged": 1}}\n'));
		child.emit("close", 0);
		expect(await done).toEqual({ seen: 1, merged: 1 });
	});

	it("takes the runner from the packaged app's resources", async () => {
		const child = new FakeChild();
		spawnMock.mockReturnValue(child);
		const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
		Object.defineProperty(process, "resourcesPath", { value: "/opt/app/resources", configurable: true });
		(app as { isPackaged: boolean }).isPackaged = true;
		try {
			const done = runExpressLane(project("a"), ON);
			await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
			const [, args, options] = spawnMock.mock.calls[0];
			expect(String(options.cwd).replaceAll("\\", "/")).toMatch(/\/opt\/app\/resources\/backend$/);
			expect(args[1].replaceAll("\\", "/")).toMatch(/resources\/backend\/runners\/express_lane_runner\.py$/);
			child.emit("close", 0);
			await done;
		} finally {
			(app as { isPackaged: boolean }).isPackaged = false;
			if (resources) Object.defineProperty(process, "resourcesPath", resources);
			else delete (process as { resourcesPath?: string }).resourcesPath;
		}
	});

	it("is an error when Python is not ready, and starts nothing", async () => {
		pythonPath.current = null;
		expect((await runExpressLane(project("a"), ON)).error).toBe("Python environment not ready");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("is an error when the process cannot start", async () => {
		spawnMock.mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		expect((await runExpressLane(project("a"), ON)).error).toBe("ENOENT");
		spawnMock.mockImplementationOnce(() => {
			throw "odd";
		});
		expect((await runExpressLane(project("a"), ON)).error).toBe("Failed to start");
	});

	it("is an error when the process fails", async () => {
		const child = new FakeChild();
		spawnMock.mockReturnValue(child);
		const done = runExpressLane(project("a"), ON);
		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
		child.emit("error", new Error("EACCES"));
		expect(await done).toEqual({ seen: 0, merged: 0, error: "EACCES" });
	});

	it("stops a runner that does not finish", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			spawnMock.mockReturnValue(child);
			const done = runExpressLane(project("a"), ON);
			await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
			vi.advanceTimersByTime(10 * 60_000);
			expect(child.kill).toHaveBeenCalled();
			child.emit("close", null);
			expect((await done).error).toBe("the express lane stopped without a result");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("startExpressLane", () => {
	it("looks once after a few minutes, then every half hour, and stops", async () => {
		vi.useFakeTimers();
		try {
			const settings = await import("../settings-utils");
			const read = vi.spyOn(settings, "readSettingsFile");
			startExpressLane();
			startExpressLane(); // a second start keeps the one timer
			await vi.advanceTimersByTimeAsync(3 * 60_000);
			expect(read).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			expect(read).toHaveBeenCalledTimes(2);
			stopExpressLane();
			await vi.advanceTimersByTimeAsync(60 * 60_000);
			expect(read).toHaveBeenCalledTimes(2);
			stopExpressLane();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start a pass while the last one still runs", async () => {
		vi.useFakeTimers();
		try {
			const settings = await import("../settings-utils");
			vi.spyOn(settings, "readSettingsFile").mockReturnValue(ON);
			stored.projects = [project("a")];
			spawnMock.mockReset();
			const child = new FakeChild();
			spawnMock.mockReturnValue(child);
			startExpressLane();
			await vi.advanceTimersByTimeAsync(3 * 60_000);
			await flush();
			expect(spawnMock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			await flush();
			expect(spawnMock).toHaveBeenCalledTimes(1);
			child.emit("close", 0);
			await flush();
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			await flush();
			expect(spawnMock).toHaveBeenCalledTimes(2);
			child.emit("close", 0);
			await flush();
		} finally {
			stopExpressLane();
			stored.projects = [];
			vi.useRealTimers();
		}
	});

	it("logs a pass that throws", async () => {
		vi.useFakeTimers();
		vi.mocked(appLog.warn).mockClear();
		try {
			const settings = await import("../settings-utils");
			const read = vi.spyOn(settings, "readSettingsFile").mockImplementation(() => {
				throw new Error("unreadable");
			});
			startExpressLane();
			await vi.advanceTimersByTimeAsync(3 * 60_000);
			expect(appLog.warn).toHaveBeenCalledWith("[EXPRESS] The pass failed: unreadable");
			read.mockImplementation(() => {
				throw "odd";
			});
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			expect(appLog.warn).toHaveBeenCalledWith("[EXPRESS] The pass failed: odd");
			stopExpressLane();
		} finally {
			vi.useRealTimers();
		}
	});
});
