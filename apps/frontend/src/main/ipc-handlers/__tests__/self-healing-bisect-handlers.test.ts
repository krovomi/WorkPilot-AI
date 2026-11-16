/**
 * The bisect channel takes an incident id and an optional commit id. A hostile
 * value of either never reaches the runner; a well-formed run streams each
 * tested commit to the window and returns the verdict.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	spawns: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
	script: (_proc: unknown): void => undefined,
	python: "/venv/bin/python",
	exists: false,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: vi.fn(async () => ({ PATH: "/usr/bin" })),
}));
vi.mock("../../python-env-manager", () => ({
	getConfiguredPythonPath: () => state.python,
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	existsSync: () => state.exists,
}));
vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[], options: Record<string, unknown>) => {
		state.spawns.push({ command, args, options });
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		queueMicrotask(() => state.script(proc));
		return proc;
	},
}));

import {
	backendDir,
	bisectArgs,
	progressEvent,
	registerSelfHealingBisectHandlers,
} from "../self-healing-bisect-handlers";

type Proc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
const SHA = "a".repeat(40);
const send = vi.fn();
let window: unknown = { webContents: { send } };

function emit(proc: unknown, ...chunks: string[]) {
	const p = proc as Proc;
	for (const chunk of chunks) p.stdout.emit("data", Buffer.from(chunk));
}

async function call(...args: unknown[]) {
	const handler = state.handlers.get(IPC_CHANNELS.SELF_HEALING_BISECT);
	if (!handler) throw new Error("not registered");
	return handler({}, ...args);
}

beforeEach(() => {
	state.handlers.clear();
	state.spawns = [];
	state.python = "/venv/bin/python";
	state.exists = false;
	send.mockReset();
	window = { webContents: { send } };
	registerSelfHealingBisectHandlers(() => window as never);
});

afterEach(() => {
	delete (process as { resourcesPath?: string }).resourcesPath;
});

describe("bisect arguments", () => {
	it.each([
		[undefined],
		[42],
		[""],
		["--project=/etc"],
		["id; rm -rf /"],
		["a".repeat(65)],
		["../incidents"],
	])("refuses the incident id %j", async (incidentId) => {
		expect(await call("/proj", incidentId)).toEqual({ success: false, error: "invalid incident id" });
		expect(state.spawns).toEqual([]);
	});

	it.each([["HEAD"], ["main"], ["--output=/tmp/x"], ["abc"], ["a".repeat(41)], [123], ["abc1234..def5678"]])(
		"refuses the green commit %j",
		async (good) => {
			expect(await call("/proj", "inc1", good)).toEqual({ success: false, error: "invalid commit id" });
			expect(state.spawns).toEqual([]);
		},
	);

	it("refuses a project that is not a path string", async () => {
		expect(await call(undefined, "inc1")).toEqual({ success: false, error: "invalid project" });
		expect(await call("", "inc1")).toEqual({ success: false, error: "invalid project" });
	});

	it("passes a valid commit id on, and none when it is left empty", () => {
		expect(bisectArgs("inc1", "abc1234")).toEqual({ args: ["bisect", "--incident-id", "inc1", "--good", "abc1234"] });
		expect(bisectArgs("inc1", null)).toEqual({ args: ["bisect", "--incident-id", "inc1"] });
		expect(bisectArgs("inc1", "")).toEqual({ args: ["bisect", "--incident-id", "inc1"] });
	});
});

describe("progress lines", () => {
	it("keeps only well-formed tested commits", () => {
		const good = { step: "bisect", sha: SHA, outcome: "bad", role: "search", tested: 2 };
		expect(progressEvent("i", good)).toEqual({
			incidentId: "i",
			step: { sha: SHA, outcome: "bad", role: "search", seconds: 0, detail: "", tested: 2 },
		});
		expect(progressEvent("i", { ...good, seconds: 1.5, detail: "x".repeat(300) })?.step.detail).toHaveLength(200);
		expect(progressEvent("i", { ...good, step: "complete" })).toBeNull();
		expect(progressEvent("i", { ...good, sha: 7 })).toBeNull();
		expect(progressEvent("i", { ...good, sha: "<img src=x>" })).toBeNull();
		expect(progressEvent("i", { ...good, outcome: "maybe" })).toBeNull();
		expect(progressEvent("i", { ...good, role: "admin" })).toBeNull();
		expect(progressEvent("i", { ...good, tested: "2" })).toBeNull();
	});
});

describe("running the runner", () => {
	it("streams each tested commit and returns the verdict", async () => {
		state.script = (proc) => {
			emit(
				proc,
				`${JSON.stringify({ step: "bisecting" })}\nnot json\n\n`,
				`${JSON.stringify({ step: "bisect", sha: SHA, outcome: "bad", role: "bad-check", tested: 1 }).slice(0, 20)}`,
				`${JSON.stringify({ step: "bisect", sha: SHA, outcome: "bad", role: "bad-check", tested: 1 }).slice(20)}\n`,
				"42\n",
				`${JSON.stringify({ step: "complete", bisect: { status: "found", first_bad: SHA } })}\n`,
			);
			(proc as Proc).emit("close", 0);
		};
		const answer = await call("/proj", "inc1", "abc1234");
		expect(answer).toEqual({ success: true, result: { status: "found", first_bad: SHA } });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toBe(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS);
		const spawned = state.spawns[0];
		expect(spawned.command).toBe("/venv/bin/python");
		expect(spawned.args.slice(1)).toEqual(["--project", "/proj", "bisect", "--incident-id", "inc1", "--good", "abc1234"]);
		expect(spawned.options.env).toEqual({ PATH: "/usr/bin" });
		expect(spawned.options).not.toHaveProperty("shell");
	});

	it("still answers when the window is gone, and says when no verdict came", async () => {
		window = null;
		state.python = "";
		state.script = (proc) => {
			emit(proc, `${JSON.stringify({ step: "bisect", sha: SHA, outcome: "good", role: "search", tested: 1 })}\n`);
			emit(proc, `${JSON.stringify({ step: "complete", bisect: "found" })}\n`);
			(proc as Proc).emit("close", 0);
		};
		expect(await call("/proj", "inc1")).toEqual({ success: false, error: "the bisect returned no result" });
		expect(state.spawns[0].command).toBe("python3");
	});

	it("reports a runner that fails or cannot start", async () => {
		state.script = (proc) => {
			(proc as Proc).stderr.emit("data", Buffer.from("Traceback"));
			(proc as Proc).emit("close", 1);
		};
		const failed = (await call("/proj", "inc1")) as { success: boolean; error: string };
		expect(failed.success).toBe(false);
		expect(failed.error).toContain("exited with code 1: Traceback");

		state.script = (proc) => (proc as Proc).emit("error", new Error("ENOENT"));
		expect(await call("/proj", "inc1")).toEqual({ success: false, error: "Error: ENOENT" });
	});
});

describe("backend folder", () => {
	it("is the packaged one when it exists, the sources' otherwise", () => {
		const dev = backendDir();
		expect(dev.endsWith(path.join("apps", "backend"))).toBe(true);
		(process as { resourcesPath?: string }).resourcesPath = "/opt/app/resources";
		expect(backendDir()).toBe(dev);
		state.exists = true;
		expect(backendDir()).toBe(path.resolve("/opt/app/resources", "backend"));
	});
});
