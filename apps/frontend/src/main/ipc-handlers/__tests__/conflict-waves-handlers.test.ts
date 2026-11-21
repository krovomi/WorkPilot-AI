/**
 * `conflictWaves:plan` revalidates what the renderer sends and never lets a
 * planning failure escape as an exception.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
	},
}));
const storeProject = vi.fn();
const storeTasks = vi.fn();
const worktreeFiles = vi.fn();
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => storeProject(id),
		getTasks: (id: string) => storeTasks(id),
	},
}));
vi.mock("../../conflict-waves/worktree-files", () => ({
	readWorktreeChangedFiles: (...args: unknown[]) => worktreeFiles(...args),
}));
const runStore = {
	readSavedRun: vi.fn(),
	writeSavedRun: vi.fn(),
	clearSavedRun: vi.fn(),
};
vi.mock("../../conflict-waves/run-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../conflict-waves/run-store")>()),
	readSavedRun: (...args: unknown[]) => runStore.readSavedRun(...args),
	writeSavedRun: (...args: unknown[]) => runStore.writeSavedRun(...args),
	clearSavedRun: (...args: unknown[]) => runStore.clearSavedRun(...args),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { Project } from "../../../shared/types/project";
import type { WavePlanDeps } from "../../conflict-waves/plan-service";
import { registerConflictWavesHandlers } from "../conflict-waves-handlers";

const PROJECT = { id: "p1", path: "/projects/p1", settings: {} } as unknown as Project;

function invoke(request: unknown, channel: string = IPC_CHANNELS.CONFLICT_WAVES_PLAN) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error("not registered");
	return handler({}, request) as Promise<{ success: boolean; error?: string; data?: unknown }>;
}

describe("conflictWaves:plan", () => {
	let deps: WavePlanDeps;
	beforeEach(() => {
		handlers.clear();
		deps = {
			getProject: vi.fn((id: string) => (id === "p1" ? PROJECT : undefined)),
			getTasks: vi.fn(() => []),
			readWorktreeFiles: vi.fn(async () => null),
			worktreeHead: vi.fn(async () => null),
			testMerge: vi.fn(async () => null),
			readCoChanges: vi.fn(async () => null),
		};
		registerConflictWavesHandlers(deps);
	});

	it.each([
		["a path instead of a project id", { projectId: "/home/user/repo" }],
		["a task id that is a path", { projectId: "p1", taskIds: ["../../../etc/passwd"] }],
		["a bogus option", { projectId: "p1", options: { tolerance: "all" } }],
		["nothing at all", undefined],
	])("refuses %s before touching the disk", async (_name, request) => {
		const result = await invoke(request);
		expect(result.success).toBe(false);
		expect(deps.readWorktreeFiles).not.toHaveBeenCalled();
		expect(deps.getTasks).not.toHaveBeenCalled();
	});

	it("answers with a plan for a known project", async () => {
		const result = await invoke({ projectId: "p1" });
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ projectId: "p1", waves: [], maxParallel: 3 });
	});

	it("turns a failure into an error result", async () => {
		deps.getTasks = vi.fn(() => {
			throw new Error("disk on fire at /secret/path");
		});
		handlers.clear();
		registerConflictWavesHandlers(deps);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = await invoke({ projectId: "p1" });
		expect(result).toEqual({ success: false, error: "Planning failed" });
		errors.mockRestore();
	});

	it("reads the project store and the worktrees by default", async () => {
		handlers.clear();
		registerConflictWavesHandlers();
		storeProject.mockReturnValue(PROJECT);
		storeTasks.mockReturnValue([
			{ id: "001-a", specId: "001-a", title: "A", status: "backlog", subtasks: [], createdAt: "2026-11-01" },
		]);
		worktreeFiles.mockResolvedValue(["src/a.rs"]);
		const result = await invoke({ projectId: "p1" });
		expect(result.success).toBe(true);
		expect(storeProject).toHaveBeenCalledWith("p1");
		expect(storeTasks).toHaveBeenCalledWith("p1");
		expect(worktreeFiles).toHaveBeenCalledWith("/projects/p1", "001-a", undefined);
	});
});

describe("the saved run channels", () => {
	const STATE = { projectId: "p1", waves: [["001-a"]], current: 0, advanceWhen: "merged", maxParallel: 2, started: [] };
	let deps: WavePlanDeps;
	beforeEach(() => {
		handlers.clear();
		for (const fn of Object.values(runStore)) fn.mockReset();
		deps = {
			getProject: vi.fn((id: string) => (id === "p1" ? PROJECT : undefined)),
			getTasks: vi.fn(() => [{ id: "001-a" }] as never),
			readWorktreeFiles: vi.fn(async () => null),
			worktreeHead: vi.fn(async () => null),
			testMerge: vi.fn(async () => null),
			readCoChanges: vi.fn(async () => null),
			now: () => new Date("2026-11-16T09:30:00Z"),
		};
		registerConflictWavesHandlers(deps);
	});

	it.each([
		["a path", "/home/user/repo"],
		["a traversal", "../p1"],
		["not a string", { id: "p1" }],
		["an unknown project", "p2"],
	])("refuses %s as project, before touching the disk", async (_name, projectId) => {
		for (const channel of [IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD, IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR]) {
			expect(await invoke(projectId, channel)).toEqual({ success: false, error: "Project not found" });
		}
		expect(await invoke({ ...STATE, projectId }, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toEqual({
			success: false,
			error: "Project not found",
		});
		expect(await invoke(null, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toMatchObject({ success: false });
		expect(runStore.readSavedRun).not.toHaveBeenCalled();
		expect(runStore.writeSavedRun).not.toHaveBeenCalled();
		expect(runStore.clearSavedRun).not.toHaveBeenCalled();
	});

	it("reads the run of the project's own path, checked against its tasks", async () => {
		runStore.readSavedRun.mockReturnValue({ run: null, ignored: false });
		const result = await invoke("p1", IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD);
		expect(result).toEqual({ success: true, data: { run: null, ignored: false } });
		expect(runStore.readSavedRun).toHaveBeenCalledWith("/projects/p1", "p1", new Set(["001-a"]));
	});

	it("answers 'ignored' when reading fails", async () => {
		runStore.readSavedRun.mockImplementation(() => {
			throw new Error("EACCES /secret/path");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await invoke("p1", IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD)).toEqual({
			success: true,
			data: { run: null, ignored: true },
		});
		errors.mockRestore();
	});

	it("saves only a validated state, stamped by the main process", async () => {
		expect(await invoke({ ...STATE, current: 9 }, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toEqual({
			success: false,
			error: "Invalid run state",
		});
		expect(runStore.writeSavedRun).not.toHaveBeenCalled();
		expect(await invoke({ ...STATE, path: "/etc" }, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toEqual({ success: true });
		expect(runStore.writeSavedRun).toHaveBeenCalledWith("/projects/p1", STATE, new Date("2026-11-16T09:30:00Z"));
	});

	it("turns a refused write or clear into an error without the path", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		runStore.writeSavedRun.mockImplementation(() => {
			throw new Error("Refusing a linked run file at /secret");
		});
		runStore.clearSavedRun.mockImplementation(() => {
			throw new Error("Refusing a linked .workpilot at /secret");
		});
		expect(await invoke(STATE, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toEqual({
			success: false,
			error: "Could not save the run",
		});
		expect(await invoke("p1", IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR)).toEqual({
			success: false,
			error: "Could not clear the run",
		});
		errors.mockRestore();
	});

	it("clears the run of the project's own path", async () => {
		expect(await invoke("p1", IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR)).toEqual({ success: true });
		expect(runStore.clearSavedRun).toHaveBeenCalledWith("/projects/p1");
	});

	it("stamps with the current time when no clock is given", async () => {
		handlers.clear();
		const { now: _unused, ...rest } = deps;
		registerConflictWavesHandlers(rest);
		expect(await invoke(STATE, IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE)).toEqual({ success: true });
		expect(runStore.writeSavedRun.mock.calls[0][2]).toBeInstanceOf(Date);
	});
});
