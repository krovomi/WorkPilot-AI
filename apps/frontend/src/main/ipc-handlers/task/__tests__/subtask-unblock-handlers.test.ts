/**
 * Answering a blocked subtask: arguments checked again in the main process,
 * the answer written to every copy of the plan (the one the panel shows
 * first), the build restarted for a retry or a reply and never while it
 * runs, and a server card answered by the server.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dirs: { main: "", worktree: "" },
	found: true,
	start: vi.fn(async () => true),
	invalidate: vi.fn(),
	serverUnblock: vi.fn(async () => ({ success: true, data: { restarted: true } })),
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../shared", () => ({
	findTaskAndProject: () =>
		state.found ? { task: { id: "t1", specId: "001-x" }, project: { id: "p1", path: "/p" } } : {},
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: () => ({
		specDir: state.dirs.main,
		mainSpecDir: state.dirs.main,
		worktreeSpecDir: state.dirs.worktree,
	}),
}));
vi.mock("../execution-utils", async () => {
	const fs = await import("node:fs");
	const p = await import("node:path");
	return {
		getPlanPaths: (paths: { specDir: string; worktreeSpecDir: string }) => {
			const primary = p.join(paths.specDir, "implementation_plan.json");
			const copy = p.join(paths.worktreeSpecDir, "implementation_plan.json");
			return { primary, all: [primary, ...(fs.existsSync(copy) ? [copy] : [])] };
		},
		atomicWriteFileSync: (file: string, content: string) =>
			fs.writeFileSync(file, content, "utf-8"),
		safeReadFileSync: (file: string) =>
			fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null,
	};
});
vi.mock("../execution-handlers", () => ({
	getTaskControl: () => ({ start: state.start }),
}));
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: state.invalidate },
}));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: (id: unknown) =>
		id === "server:p-1:001-a" ? { project: { id: "p-1" }, cardId: "001-a" } : null,
}));
vi.mock("../../../server-board-review", () => ({
	unblockServerSubtask: state.serverUnblock,
}));

import { unblockSubtask } from "../subtask-unblock-handlers";

let root = "";
const notRunning = () => false;

function plan(status = "blocked") {
	return {
		status: "human_review",
		phases: [
			{
				name: "Implementation",
				subtasks: [
					{ id: "subtask-1", status: "completed" },
					{ id: "subtask-2", status, _blocked_reason: "Check it" },
				],
			},
		],
	};
}

function read(dir: string) {
	return JSON.parse(readFileSync(path.join(dir, "implementation_plan.json"), "utf-8"));
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "unblock-"));
	state.dirs.main = path.join(root, "main");
	state.dirs.worktree = path.join(root, "worktree");
	for (const dir of [state.dirs.main, state.dirs.worktree]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "implementation_plan.json"), JSON.stringify(plan()), "utf-8");
	}
	state.found = true;
	state.start.mockClear();
	state.invalidate.mockClear();
	state.serverUnblock.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("unblockSubtask", () => {
	it("marks it done in every plan copy without restarting", async () => {
		const result = await unblockSubtask(notRunning, "t1", "subtask-2", "complete", undefined);
		expect(result).toEqual({ success: true, data: { restarted: false } });
		for (const dir of [state.dirs.main, state.dirs.worktree]) {
			const subtask = read(dir).phases[0].subtasks[1];
			expect(subtask.status).toBe("completed");
			expect(subtask.human_resolution.reason).toBe("Check it");
		}
		expect(state.start).not.toHaveBeenCalled();
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("sends a reply and restarts the build", async () => {
		const result = await unblockSubtask(notRunning, "t1", "subtask-2", "answer", "In docs/");
		expect(result).toEqual({ success: true, data: { restarted: true } });
		const saved = read(state.dirs.main);
		expect(saved.phases[0].subtasks[1]).toMatchObject({
			status: "pending",
			human_reply: "In docs/",
		});
		expect(saved.status).toBe("in_progress");
		expect(state.start).toHaveBeenCalledWith("t1");
	});

	it("never restarts a running task", async () => {
		const result = await unblockSubtask(() => true, "t1", "subtask-2", "retry", undefined);
		expect(result).toEqual({ success: false, error: "task_running" });
		expect(read(state.dirs.main).phases[0].subtasks[1].status).toBe("blocked");
		expect(state.start).not.toHaveBeenCalled();
	});

	it("checks its arguments again", async () => {
		expect((await unblockSubtask(notRunning, 42, "subtask-2", "complete", undefined)).error).toBe(
			"task_not_found",
		);
		expect((await unblockSubtask(notRunning, "t1", "../x", "complete", undefined)).error).toBe(
			"subtask_not_found",
		);
		expect((await unblockSubtask(notRunning, "t1", "subtask-2", "rm", undefined)).error).toBe(
			"invalid_action",
		);
		expect((await unblockSubtask(notRunning, "t1", "subtask-2", "answer", { a: 1 })).error).toBe(
			"invalid_action",
		);
		expect(
			(await unblockSubtask(notRunning, "t1", "subtask-2", "answer", "x".repeat(4001))).error,
		).toBe("reply_too_long");
		expect((await unblockSubtask(notRunning, "t1", "subtask-1", "skip", undefined)).error).toBe(
			"not_blocked",
		);
		state.found = false;
		expect((await unblockSubtask(notRunning, "t1", "subtask-2", "skip", undefined)).error).toBe(
			"task_not_found",
		);
	});

	it("keeps going when a copy does not hold the subtask", async () => {
		writeFileSync(
			path.join(state.dirs.worktree, "implementation_plan.json"),
			JSON.stringify({ phases: [] }),
			"utf-8",
		);
		const result = await unblockSubtask(notRunning, "t1", "subtask-2", "skip", undefined);
		expect(result.success).toBe(true);
		expect(read(state.dirs.main).phases[0].subtasks[1].status).toBe("completed");
		expect(existsSync(path.join(state.dirs.worktree, "implementation_plan.json"))).toBe(true);
	});

	it("sends a server card's answer to the server", async () => {
		const result = await unblockSubtask(
			notRunning,
			"server:p-1:001-a",
			"subtask-2",
			"answer",
			"Use the staging account",
		);
		expect(result).toEqual({ success: true, data: { restarted: true } });
		expect(state.serverUnblock).toHaveBeenCalledWith(
			{ project: { id: "p-1" }, cardId: "001-a" },
			"subtask-2",
			"answer",
			"Use the staging account",
		);
	});
});
