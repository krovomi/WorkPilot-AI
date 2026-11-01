/**
 * Goal mode handlers: the goal is validated here with the backend's rules and
 * written to every copy of the spec directory, main copy first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	dirs: { main: "", worktree: "" as string | null },
	found: true,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(channel, fn),
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () =>
		state.found ? { task: { id: "t1", specId: "001-x" }, project: { path: "/p" } } : {},
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: () => ({
		specDir: state.dirs.main,
		mainSpecDir: state.dirs.main,
		worktreeSpecDir: state.dirs.worktree,
	}),
	allSpecDirs: (p: { specDir: string; worktreeSpecDir: string | null }) =>
		[p.worktreeSpecDir, p.specDir].filter((d): d is string => !!d && existsSync(d)),
}));
vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
const server = vi.hoisted(() => ({
	findServerCard: vi.fn((id: unknown) =>
		id === "server:p-1:001-a" ? { project: { id: "p-1" }, cardId: "001-a" } : null,
	),
	getServerCardGoal: vi.fn(),
	setServerCardGoal: vi.fn(),
}));
vi.mock("../../../server-board-actions", () => ({ findServerCard: server.findServerCard }));
vi.mock("../../../server-card-settings", () => ({
	getServerCardGoal: server.getServerCardGoal,
	setServerCardGoal: server.setServerCardGoal,
}));

import { GOAL_FILE, readGoal, registerGoalHandlers, sanitizeGoal } from "../goal-handlers";

registerGoalHandlers();

const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<{
		success: boolean;
		error?: string;
		data?: { goal: unknown; error?: string };
	}>;

let root = "";

describe("goal handlers", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "goal-"));
		state.dirs.main = path.join(root, "main");
		state.dirs.worktree = path.join(root, "wt");
		mkdirSync(state.dirs.main);
		mkdirSync(state.dirs.worktree);
		state.found = true;
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("writes the goal in every copy and reads it back", async () => {
		const set = await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", {
			command: " dotnet test ",
			maxCostUsd: 3,
			protected: ["tests\\**", "tests/**"],
			extra: "dropped",
		});
		expect(set.success).toBe(true);
		const expected = { command: "dotnet test", maxCostUsd: 3, protected: ["tests/**"] };
		for (const dir of [state.dirs.main, state.dirs.worktree as string]) {
			expect(JSON.parse(readFileSync(path.join(dir, GOAL_FILE), "utf-8"))).toEqual(expected);
		}
		expect((await call(IPC_CHANNELS.TASK_GOAL_GET, "t1")).data).toEqual({ goal: expected });
	});

	it("removes the goal everywhere with null", async () => {
		await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", { command: "npm test" });
		expect((await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", null)).success).toBe(true);
		expect(existsSync(path.join(state.dirs.main, GOAL_FILE))).toBe(false);
		expect(existsSync(path.join(state.dirs.worktree as string, GOAL_FILE))).toBe(false);
	});

	it("reads the main copy first, as the backend does", async () => {
		writeFileSync(path.join(state.dirs.main, GOAL_FILE), JSON.stringify({ command: "new" }));
		writeFileSync(path.join(state.dirs.worktree as string, GOAL_FILE), JSON.stringify({ command: "old" }));
		expect((await call(IPC_CHANNELS.TASK_GOAL_GET, "t1")).data?.goal).toEqual({ command: "new" });
	});

	it("replaces a planted symbolic link instead of writing through it", async () => {
		const target = path.join(root, "outside.json");
		writeFileSync(target, "untouched");
		symlinkSync(target, path.join(state.dirs.main, GOAL_FILE));
		await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", { command: "npm test" });
		expect(readFileSync(target, "utf-8")).toBe("untouched");
	});

	it("refuses a goal the backend would refuse, and writes nothing", async () => {
		const result = await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", { command: "x", protected: ["../up"] });
		expect(result.success).toBe(false);
		expect(existsSync(path.join(state.dirs.main, GOAL_FILE))).toBe(false);
	});

	it("says when the file on disk cannot be read", () => {
		writeFileSync(path.join(state.dirs.main, GOAL_FILE), "{nope");
		const read = readGoal([state.dirs.main]);
		expect(read.goal).toBeNull();
		expect(read.error).toBeTruthy();
	});

	it("refuses an unknown task and a task id that is not a string", async () => {
		expect((await call(IPC_CHANNELS.TASK_GOAL_GET, { id: "t1" })).success).toBe(false);
		state.found = false;
		expect((await call(IPC_CHANNELS.TASK_GOAL_SET, "t1", { command: "x" })).success).toBe(false);
	});
});

describe("sanitizeGoal", () => {
	it.each([
		[null],
		[[]],
		[{}],
		[{ command: "a\nb" }],
		[{ command: "x", expectedExit: 1.5 }],
		[{ command: "x", expectedExit: 256 }],
		[{ command: "x", timeoutSeconds: 5 }],
		[{ command: "x", maxRounds: 0 }],
		[{ command: "x", maxCostUsd: Number.NaN }],
		[{ command: "x", maxCostUsd: -1 }],
		[{ command: "x", protected: "tests" }],
		[{ command: "x", protected: ["/etc"] }],
		[{ command: "x", protected: ["C:/repo"] }],
	])("refuses %j", (raw) => {
		expect(sanitizeGoal(raw).error).toBeTruthy();
	});

	it("keeps the fields it knows", () => {
		expect(
			sanitizeGoal({ command: "pytest", expectedExit: 0, maxRounds: 4, timeoutSeconds: 60, protected: [] }),
		).toEqual({ goal: { command: "pytest", expectedExit: 0, maxRounds: 4, timeoutSeconds: 60 } });
	});
});

describe("goal of a server card", () => {
	it("is read from and written to the server, never to the mirror", async () => {
		server.getServerCardGoal.mockResolvedValue({ success: true, data: { goal: null } });
		server.setServerCardGoal.mockResolvedValue({
			success: true,
			data: { goal: { command: "npm test" } },
		});
		expect((await call(IPC_CHANNELS.TASK_GOAL_GET, "server:p-1:001-a")).data).toEqual({ goal: null });
		const set = await call(IPC_CHANNELS.TASK_GOAL_SET, "server:p-1:001-a", { command: " npm test " });
		expect(set.success).toBe(true);
		expect(server.setServerCardGoal).toHaveBeenCalledWith(
			{ project: { id: "p-1" }, cardId: "001-a" },
			{ command: "npm test" },
		);
	});

	it("is validated here before it goes", async () => {
		server.setServerCardGoal.mockClear();
		const set = await call(IPC_CHANNELS.TASK_GOAL_SET, "server:p-1:001-a", { command: "a\nb" });
		expect(set.success).toBe(false);
		expect(server.setServerCardGoal).not.toHaveBeenCalled();
	});
});
