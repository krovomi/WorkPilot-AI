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

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { Project } from "../../../shared/types/project";
import type { WavePlanDeps } from "../../conflict-waves/plan-service";
import { registerConflictWavesHandlers } from "../conflict-waves-handlers";

const PROJECT = { id: "p1", path: "/projects/p1", settings: {} } as unknown as Project;

function invoke(request: unknown) {
	const handler = handlers.get(IPC_CHANNELS.CONFLICT_WAVES_PLAN);
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
