/**
 * "How you compare" on this computer: the runner is given the registered
 * project and the person's other registered projects, never a folder the
 * renderer chose; what it prints is checked before a view draws it.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	projects: [] as Array<{ path: string; name: string }>,
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	packaged: false,
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return mocks.packaged;
		},
		getAppPath: () => "/app/frontend",
	},
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));
vi.mock("../project-store", () => ({
	projectStore: { getProjects: () => mocks.projects },
}));
vi.mock("../utils/ensure-python", () => ({
	requirePythonPath: vi.fn(async () => "/py/python"),
}));
vi.mock("../utils/python-runner-env", () => ({
	pythonStaticRunnerEnv: vi.fn(() => ({ PATH: "/bin" })),
}));

import {
	buildComparePayload,
	compareLocalProject,
	parseBuildCompareOutput,
	RUN_TIMEOUT_MS,
} from "../build-compare";
import { MAX_OTHERS, toBuildComparison } from "../build-compare-shape";
import { registerBuildCompareHandlers } from "../ipc-handlers/build-compare-handlers";

const HERE = path.resolve("/work/shop");

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
	kill = vi.fn();
}

function child(): FakeChild {
	const fake = new FakeChild();
	mocks.spawn.mockReturnValueOnce(fake);
	return fake;
}

/** Wait for the handler to reach `spawn` (it awaits the Python path first). */
async function spawned(times = 1) {
	await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(times));
}

const answer = {
	window_days: 30,
	min_group: 2,
	min_top: 10,
	segment: { stack: "csharp", size: "medium", team: "solo", size_from: "small", team_from: null },
	recent: { specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, mutation_score: null, ci_first_pass: null },
	previous: { specs: 1, minutes: 80, cost: 3, qa_iterations: null, agents: 2, mutation_score: null, ci_first_pass: null },
	trend: { minutes: -50, cost: -50, qa_iterations: null, agents: 50, mutation_score: null, ci_first_pass: null },
	weeks: [
		{ specs: 0, minutes: null, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null },
		{ specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, mutation_score: null, ci_first_pass: null },
	],
	groups: {
		segment: { projects: 1, medians: null, top: null, trend: null },
		stack: { projects: 2, medians: { minutes: 30, cost: 1, qa_iterations: null, agents: 2, mutation_score: null, ci_first_pass: null }, top: null, trend: null },
		team: { projects: 1, medians: null, top: null, trend: null },
		all: {
			projects: 12,
			medians: { minutes: 35, cost: 1.2, qa_iterations: 2, agents: 2, mutation_score: null, ci_first_pass: null },
			top: { minutes: 10, cost: 0.3, qa_iterations: null, agents: 1, mutation_score: null, ci_first_pass: null },
			trend: { minutes: -4, cost: 2, qa_iterations: null, agents: null, mutation_score: 3, ci_first_pass: -10 },
		},
	},
	kinds: [
		{
			kind: "bug_fix",
			specs: 1,
			minutes: 40,
			cost: 1.5,
			qa_iterations: 1,
			agents: 3, mutation_score: null, ci_first_pass: null,
			group: { projects: 1, medians: null, top: null, trend: null },
		},
	],
	projects: [
		{ name: "Shop", stack: "csharp", size: "medium", team: "solo", specs: 2, minutes: 40, cost: 1.5, qa_iterations: 1, agents: 3, mutation_score: null, ci_first_pass: null, current: true },
		{ name: "Blog", stack: "php", size: "small", team: "unknown", specs: 1, minutes: 10, cost: 0.2, qa_iterations: null, agents: 1, mutation_score: null, ci_first_pass: null, current: false },
	],
};

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.packaged = false;
	mocks.projects = [
		{ path: "/work/shop", name: "Shop" },
		{ path: "/work/blog", name: "Blog" },
	];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("toBuildComparison", () => {
	it("keeps a well-formed comparison as it is", () => {
		expect(toBuildComparison(answer)).toEqual(answer);
	});

	it("checks every number and label again", () => {
		const hostile = toBuildComparison({
			window_days: -3,
			min_group: "5",
			segment: { stack: "x".repeat(500), size: 7, size_from: "", team_from: "y".repeat(90) },
			recent: { specs: 1.5, minutes: Number.NaN, cost: -1, qa_iterations: "2", agents: Infinity, mutation_score: 101, ci_first_pass: 100 },
			previous: "none",
			trend: { minutes: -20, cost: Number.POSITIVE_INFINITY },
			groups: {
				segment: "x",
				stack: { projects: -1, medians: [], top: "best", trend: [] },
				team: { projects: 6, medians: { mutation_score: 140, ci_first_pass: 40 }, trend: { minutes: -12, cost: "up" } },
			},
			min_top: -4,
			weeks: [...Array.from({ length: 30 }, () => ({ specs: 1, minutes: -5 }))],
			kinds: [
				"x",
				{ kind: "<img src=x>", specs: 1 },
				{ kind: 7 },
				{ kind: "hotfix", specs: 2, minutes: 5, group: { projects: 3, medians: { cost: "free" }, top: { cost: 0.1 } } },
				...Array.from({ length: 40 }, () => ({ kind: "feature" })),
			],
			projects: [
				"x",
				{ name: "", stack: "", size: null, current: "yes" },
				...Array.from({ length: MAX_OTHERS + 10 }, () => ({ name: "p" })),
			],
		});
		expect(hostile?.window_days).toBe(1);
		expect(hostile?.min_group).toBe(1);
		expect(hostile?.segment).toEqual({
			stack: "x".repeat(40),
			size: "unknown",
			team: "unknown",
			size_from: null,
			team_from: "y".repeat(40),
		});
		expect(hostile?.min_top).toBeNull();
		expect(hostile?.weeks).toHaveLength(12);
		expect(hostile?.weeks[0]).toEqual({ specs: 1, minutes: null, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null });
		// Only a short identifier names a kind; the lists are bounded.
		expect(hostile?.kinds[0]).toEqual({
			kind: "hotfix",
			specs: 2,
			minutes: 5,
			cost: null,
			qa_iterations: null,
			agents: null,
			mutation_score: null, ci_first_pass: null,
			group: {
				projects: 3,
				medians: { minutes: null, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null },
				top: { minutes: null, cost: 0.1, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null },
				trend: null,
			},
		});
		expect(hostile?.kinds).toHaveLength(13);
		// A figure in percent is at most 100.
		expect(hostile?.recent).toEqual({
			specs: 0,
			minutes: null,
			cost: null,
			qa_iterations: null,
			agents: null,
			mutation_score: null,
			ci_first_pass: 100,
		});
		expect(hostile?.previous.specs).toBe(0);
		expect(hostile?.trend).toEqual({ minutes: -20, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null });
		const empty = { projects: 0, medians: null, top: null, trend: null };
		expect(hostile?.groups.segment).toEqual(empty);
		expect(hostile?.groups.stack).toEqual(empty);
		expect(hostile?.groups.team).toEqual({
			projects: 6,
			medians: { minutes: null, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: 40 },
			top: null,
			trend: { minutes: -12, cost: null, qa_iterations: null, agents: null, mutation_score: null, ci_first_pass: null },
		});
		expect(hostile?.groups.all).toEqual(empty);
		expect(hostile?.projects[0]).toMatchObject({ name: "?", stack: "other", size: "unknown", team: "unknown", current: false });
		expect(hostile?.projects).toHaveLength(MAX_OTHERS);
	});

	it("refuses what is not an object", () => {
		expect(toBuildComparison(null)).toBeNull();
		expect(toBuildComparison([answer])).toBeNull();
		expect(toBuildComparison({})?.projects).toEqual([]);
	});
});

describe("buildComparePayload", () => {
	it("sends the registered project and the person's other projects", () => {
		mocks.projects.push({ path: "/work/shop/", name: "Twice" });
		expect(JSON.parse(buildComparePayload("/work/shop") as string)).toEqual({
			current: { path: HERE, name: "Shop" },
			others: [{ path: path.resolve("/work/blog"), name: "Blog" }],
		});
	});

	it("sends at most the projects the runner reads", () => {
		mocks.projects.push(
			...Array.from({ length: MAX_OTHERS + 5 }, (_, i) => ({ path: `/work/p${i}`, name: `P${i}` })),
		);
		expect(JSON.parse(buildComparePayload("/work/shop") as string).others).toHaveLength(MAX_OTHERS);
	});

	it.each([undefined, "", 42, "/elsewhere"])("refuses %o", (projectPath) => {
		expect(buildComparePayload(projectPath)).toBeNull();
	});
});

describe("parseBuildCompareOutput", () => {
	it("reads the result line among other output", () => {
		expect(parseBuildCompareOutput('noise\nBUILD_COMPARE_RESULT:{"a":1}\n')).toEqual({
			result: { a: 1 },
			error: undefined,
		});
	});

	it("reports the runner's error and an unreadable result", () => {
		expect(parseBuildCompareOutput("BUILD_COMPARE_ERROR:No such project\n").error).toBe("No such project");
		expect(parseBuildCompareOutput("BUILD_COMPARE_RESULT:{oops\n").error).toMatch(/Unreadable/);
	});
});

describe("compareLocalProject", () => {
	it("refuses a folder that is not a registered project, before any process", async () => {
		expect(await compareLocalProject("/elsewhere")).toEqual({ success: false, error: "Unknown project" });
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("runs the runner of the backend with the request on stdin", async () => {
		const fake = child();
		const pending = compareLocalProject("/work/shop");
		await spawned();
		const [exe, args, options] = mocks.spawn.mock.calls[0];
		expect(exe).toBe("/py/python");
		expect(args).toEqual([path.resolve("/app/backend/runners/build_compare_runner.py")]);
		expect(options).toEqual({ cwd: path.resolve("/app/backend"), env: { PATH: "/bin" } });
		expect(JSON.parse(fake.stdin.end.mock.calls[0][0]).current.name).toBe("Shop");
		fake.stdout.emit("data", Buffer.from(`BUILD_COMPARE_RESULT:${JSON.stringify(answer)}\n`));
		fake.emit("close", 0);
		expect(await pending).toEqual({ success: true, data: answer });
	});

	it("runs the packaged backend's runner", async () => {
		mocks.packaged = true;
		Object.defineProperty(process, "resourcesPath", { value: "/res", configurable: true });
		const fake = child();
		const pending = compareLocalProject("/work/shop");
		await spawned();
		expect(mocks.spawn.mock.calls[0][2].cwd).toBe(path.resolve("/res", "backend"));
		fake.emit("close", 1);
		expect(await pending).toEqual({ success: false, error: "The comparison exited with code 1" });
	});

	it("reports the runner's error, then its last stderr line", async () => {
		const first = child();
		const failing = compareLocalProject("/work/shop");
		await spawned();
		first.stdout.emit("data", Buffer.from("BUILD_COMPARE_ERROR:A project must be an object\n"));
		first.emit("close", 1);
		expect(await failing).toEqual({ success: false, error: "A project must be an object" });

		const second = child();
		const crashing = compareLocalProject("/work/shop");
		await spawned(2);
		second.stderr.emit("data", Buffer.from("Traceback\nImportError: x\n"));
		second.stdin.emit("error", new Error("EPIPE"));
		second.emit("close", 1);
		expect(await crashing).toEqual({ success: false, error: "ImportError: x" });
	});

	it("reports a runner that does not start", async () => {
		const fake = child();
		const pending = compareLocalProject("/work/shop");
		await spawned();
		fake.emit("error", new Error("ENOENT"));
		expect(await pending).toEqual({ success: false, error: "Failed to start the comparison: ENOENT" });
	});

	it("replaces the comparison still running for the project", async () => {
		const first = child();
		const second = child();
		const old = compareLocalProject("/work/shop");
		await spawned();
		const fresh = compareLocalProject("/work/shop");
		await spawned(2);
		expect(first.kill).toHaveBeenCalledWith("SIGTERM");
		second.stdout.emit("data", Buffer.from(`BUILD_COMPARE_RESULT:${JSON.stringify(answer)}\n`));
		second.emit("close", 0);
		first.emit("close", null);
		expect((await fresh).success).toBe(true);
		expect((await old).success).toBe(false);
	});

	it("stops a runner that takes too long", async () => {
		vi.useFakeTimers();
		const fake = child();
		const pending = compareLocalProject("/work/shop");
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		vi.advanceTimersByTime(RUN_TIMEOUT_MS);
		expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
		fake.emit("close", null);
		expect((await pending).success).toBe(false);
	});
});

describe("the handler", () => {
	it("compares the project the renderer names by its folder", async () => {
		registerBuildCompareHandlers();
		const handler = mocks.handlers.get(IPC_CHANNELS.DASHBOARD_COMPARE);
		expect(await handler?.({}, "/elsewhere")).toEqual({ success: false, error: "Unknown project" });
	});
});
