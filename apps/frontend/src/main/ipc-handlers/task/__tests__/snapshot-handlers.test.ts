/**
 * The snapshot handlers: a local task's snapshots are listed and restored by
 * the runner; a server card, a bad task name, a bad snapshot id and a running
 * task are refused before the runner starts.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	runs: [] as string[][],
	stdout: "" as string,
	spawnError: null as unknown,
	childMode: "close" as "close" | "error" | "hang",
	packaged: false,
	task: undefined as unknown,
	project: undefined as unknown,
	serverCard: false,
	python: "python3" as string | null,
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return state.packaged;
		},
		getAppPath: () => "/app/frontend",
	},
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (_command: string, args: string[]) => {
		if (state.spawnError) throw state.spawnError;
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		});
		state.runs.push(args);
		if (state.childMode === "hang") return child;
		setImmediate(() => {
			if (state.childMode === "error") {
				child.emit("error", new Error("spawn EACCES"));
				return;
			}
			child.stderr.write("debug line\n");
			child.stdout.write(state.stdout);
			child.emit("close", 0);
		});
		return child;
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () => ({ task: state.task, project: state.project }),
}));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: () => (state.serverCard ? { id: "card" } : undefined),
}));
vi.mock("../../../utils/ensure-python", () => ({
	readyPythonPath: async () => state.python,
}));
vi.mock("../../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, []],
}));
vi.mock("../../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async () => ({ PATH: "/usr/bin" }),
}));
vi.mock("../../../app-logger", () => ({ appLog: { debug: vi.fn(), info: vi.fn() } }));

import {
	listTaskSnapshots,
	parseSnapshotOutput,
	registerSnapshotHandlers,
	restoreTaskSnapshot,
} from "../snapshot-handlers";

const SNAP = {
	snapshot_id: "20261115T142000000000Z-coding",
	commit: "abc",
	head: "def",
	created_at: "2026-11-15T14:20:00Z",
	label: "coding",
};
const idle = { isRunning: () => false };

beforeEach(() => {
	state.runs = [];
	state.stdout = "";
	state.spawnError = null;
	state.childMode = "close";
	state.packaged = false;
	state.task = { id: "t1", specId: "001-add-login" };
	state.project = { path: "/projects/app" };
	state.serverCard = false;
	state.python = "python3";
});

describe("parseSnapshotOutput", () => {
	it("keeps the last JSON object", () => {
		expect(parseSnapshotOutput('{"a":1}\nnoise\n{"b":2}\n')).toEqual({ b: 2 });
		expect(parseSnapshotOutput("[1]\nnot json")).toEqual({
			error: "The snapshot runner gave no answer",
		});
	});
});

describe("listTaskSnapshots", () => {
	it("lists through the runner and drops malformed entries", async () => {
		state.stdout = `${JSON.stringify({ snapshots: [SNAP, { snapshot_id: "../x" }, null] })}\n`;
		const result = await listTaskSnapshots("t1");
		expect(result).toEqual({ success: true, data: [SNAP] });
		expect(state.runs[0]).toEqual([
			expect.stringContaining("snapshot_runner.py"),
			"list",
			"--project-dir",
			"/projects/app",
			"--task",
			"001-add-login",
		]);
	});

	it("passes the runner's error on", async () => {
		state.stdout = '{"error":"Not a task worktree"}';
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "Not a task worktree" });
	});

	it("treats a reply without a list as empty", async () => {
		state.stdout = "{}";
		expect(await listTaskSnapshots("t1")).toEqual({ success: true, data: [] });
	});

	it("refuses what it cannot locate", async () => {
		expect(await listTaskSnapshots(42)).toEqual({ success: false, error: "Invalid task" });
		state.serverCard = true;
		expect((await listTaskSnapshots("t1")).error).toMatch(/server/);
		state.serverCard = false;
		state.task = undefined;
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "Task not found" });
		state.task = { id: "t1", specId: "a/../../etc" };
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "Invalid task" });
		state.task = { id: "t1", specId: "a..b" };
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "Invalid task" });
		expect(state.runs).toHaveLength(0);
	});

	it("says when Python is not ready or fails to start", async () => {
		state.python = null;
		expect(await listTaskSnapshots("t1")).toEqual({
			success: false,
			error: "Python environment not ready",
		});
		state.python = "python3";
		state.spawnError = new Error("ENOENT");
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "ENOENT" });
		state.spawnError = "not an Error";
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "Failed to start" });
	});
});

describe("the runner process", () => {
	it("runs the packaged backend, and reports a process error", async () => {
		state.packaged = true;
		state.childMode = "error";
		Object.defineProperty(process, "resourcesPath", { value: "/opt/workpilot/resources", configurable: true });
		expect(await listTaskSnapshots("t1")).toEqual({ success: false, error: "spawn EACCES" });
		expect(state.runs[0][0]).toBe(
			path.join(path.resolve("/opt/workpilot/resources", "backend"), "runners", "snapshot_runner.py"),
		);
	});

	it("gives up on a runner that never answers", async () => {
		vi.useFakeTimers();
		try {
			state.childMode = "hang";
			const pending = listTaskSnapshots("t1");
			await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
			expect(await pending).toEqual({ success: false, error: "The snapshot runner timed out" });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("restoreTaskSnapshot", () => {
	it("restores through the runner", async () => {
		state.stdout = JSON.stringify({ restored: SNAP.snapshot_id, safety: "20261115T150000000000Z-before_rollback" });
		const result = await restoreTaskSnapshot(idle, "t1", SNAP.snapshot_id);
		expect(result).toEqual({
			success: true,
			data: { restored: SNAP.snapshot_id, safety: "20261115T150000000000Z-before_rollback" },
		});
		expect(state.runs[0]).toEqual(
			expect.arrayContaining(["rollback", "--snapshot", SNAP.snapshot_id, "--task", "001-add-login"]),
		);
	});

	it("refuses a bad id, a running task and a half answer", async () => {
		expect(await restoreTaskSnapshot(idle, "t1", "../../HEAD")).toEqual({
			success: false,
			error: "Invalid snapshot",
		});
		expect(await restoreTaskSnapshot({ isRunning: () => true }, "t1", SNAP.snapshot_id)).toEqual({
			success: false,
			error: "Stop the task before restoring a snapshot",
		});
		expect(state.runs).toHaveLength(0);
		state.stdout = '{"restored":"x"}';
		expect((await restoreTaskSnapshot(idle, "t1", SNAP.snapshot_id)).success).toBe(false);
		state.stdout = '{"error":"Unknown snapshot"}';
		expect(await restoreTaskSnapshot(idle, "t1", SNAP.snapshot_id)).toEqual({
			success: false,
			error: "Unknown snapshot",
		});
		state.serverCard = true;
		expect((await restoreTaskSnapshot(idle, "t1", SNAP.snapshot_id)).success).toBe(false);
	});
});

describe("registerSnapshotHandlers", () => {
	it("registers both channels", async () => {
		registerSnapshotHandlers(idle as never);
		state.stdout = JSON.stringify({ snapshots: [SNAP] });
		const list = state.handlers.get(IPC_CHANNELS.TASK_SNAPSHOTS_LIST);
		expect(await list?.({}, "t1")).toEqual({ success: true, data: [SNAP] });
		const restore = state.handlers.get(IPC_CHANNELS.TASK_SNAPSHOT_RESTORE);
		expect(await restore?.({}, "t1", "bad")).toEqual({ success: false, error: "Invalid snapshot" });
	});
});
