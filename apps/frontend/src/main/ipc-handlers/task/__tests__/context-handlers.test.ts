/**
 * @vitest-environment node
 *
 * The manual "compact now" / "new thread" command and the live edit of a
 * task's context policy, on real spec folders (main project and worktree).
 * The action comes from the renderer, so it is checked again here; a marker
 * is only dropped for a running task; a folder that cannot be written is
 * reported and the others still get the file.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	found: {} as { task?: unknown; project?: unknown },
	running: true,
	logWarn: vi.fn(),
}));

vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: state.logWarn, error: vi.fn() },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent";
import { TASK_WORKTREE_DIR } from "../../../worktree-paths";
import { CONTEXT_ACTION_FILE, TASK_METADATA_FILE } from "../context-files";
import { registerTaskContextHandlers } from "../context-handlers";

type Result = { success: boolean; error?: string; data?: { contextPolicy: unknown } };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const SPEC_ID = "001-context";
let root: string;
let mainSpec: string;
let worktreeSpec: string;
let task: { id: string; specId: string; title: string; metadata?: Record<string, unknown> };

/** A folder where the atomic write puts its temp file makes the write fail. */
const blockWrites = (dir: string, file: string) =>
	mkdirSync(path.join(dir, `${file}.${process.pid}.tmp`), { recursive: true });

const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "ctx-handlers-"));
	mainSpec = path.join(root, ".workpilot", "specs", SPEC_ID);
	worktreeSpec = path.join(root, TASK_WORKTREE_DIR, SPEC_ID, ".workpilot", "specs", SPEC_ID);
	mkdirSync(mainSpec, { recursive: true });
	mkdirSync(worktreeSpec, { recursive: true });
	task = { id: "task-1", specId: SPEC_ID, title: "Context" };
	state.found = { task, project: { id: "p1", path: root } };
	state.running = true;
	state.logWarn.mockClear();
	registerTaskContextHandlers({
		isRunning: vi.fn(() => state.running),
	} as unknown as AgentManager);
});

afterEach(() => {
	ipcMain.removeHandler(IPC_CHANNELS.TASK_CONTEXT_ACTION);
	ipcMain.removeHandler(IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE);
	rmSync(root, { recursive: true, force: true });
});

describe("TASK_CONTEXT_ACTION", () => {
	it("drops the marker in the main spec and in the worktree", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "task-1", "compact");

		expect(result).toEqual({ success: true });
		for (const dir of [mainSpec, worktreeSpec]) {
			expect(read(path.join(dir, CONTEXT_ACTION_FILE))).toMatchObject({ action: "compact" });
		}
	});

	it.each([["summarize"], [""], [42], [null], [{ action: "clear" }]])(
		"refuses an action the backend does not know: %j",
		async (action) => {
			const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "task-1", action);

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/^Invalid context action/);
			expect(existsSync(path.join(mainSpec, CONTEXT_ACTION_FILE))).toBe(false);
		},
	);

	it("answers that the task is unknown", async () => {
		state.found = {};

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "nope", "clear");

		expect(result).toEqual({ success: false, error: "Task not found" });
	});

	it("leaves no marker for a stopped task, which would fire on its next run", async () => {
		state.running = false;

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "task-1", "clear");

		expect(result).toEqual({ success: false, error: "Task is not running" });
		expect(existsSync(path.join(mainSpec, CONTEXT_ACTION_FILE))).toBe(false);
		expect(existsSync(path.join(worktreeSpec, CONTEXT_ACTION_FILE))).toBe(false);
	});

	it("still succeeds when one copy cannot be written, and says which", async () => {
		blockWrites(mainSpec, CONTEXT_ACTION_FILE);

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "task-1", "clear");

		expect(result).toEqual({ success: true });
		expect(read(path.join(worktreeSpec, CONTEXT_ACTION_FILE))).toMatchObject({ action: "clear" });
		expect(state.logWarn).toHaveBeenCalledWith(
			expect.stringContaining(mainSpec),
			expect.anything(),
		);
	});

	it("fails when no copy can be written", async () => {
		blockWrites(mainSpec, CONTEXT_ACTION_FILE);
		blockWrites(worktreeSpec, CONTEXT_ACTION_FILE);

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_ACTION, "task-1", "clear");

		expect(result).toEqual({ success: false, error: "Could not write context action marker" });
		expect(state.logWarn).toHaveBeenCalledTimes(2);
	});
});

describe("TASK_CONTEXT_POLICY_UPDATE", () => {
	it("merges the change into every metadata copy and the cached task", async () => {
		task.metadata = { contextPolicy: { mode: "clear", thresholdPct: 70, prepareHandoff: false } };
		for (const dir of [mainSpec, worktreeSpec]) {
			writeFileSync(path.join(dir, TASK_METADATA_FILE), JSON.stringify({ model: "m" }));
		}

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE, "task-1", {
			thresholdPct: 60,
		});

		const expected = { mode: "clear", thresholdPct: 60, prepareHandoff: false };
		expect(result).toEqual({ success: true, data: { contextPolicy: expected } });
		for (const dir of [mainSpec, worktreeSpec]) {
			expect(read(path.join(dir, TASK_METADATA_FILE))).toEqual({
				model: "m",
				contextPolicy: expected,
			});
		}
		expect(task.metadata).toEqual({ contextPolicy: expected });
	});

	it("normalizes what the renderer sends instead of writing it as is", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE, "task-1", {
			mode: "rm -rf",
			prepareHandoff: "yes",
		});

		expect(result.success).toBe(true);
		expect(result.data?.contextPolicy).toEqual({
			mode: "auto",
			thresholdPct: 50,
			prepareHandoff: true,
		});
	});

	it("answers that the task is unknown", async () => {
		state.found = {};

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE, "nope", {});

		expect(result).toEqual({ success: false, error: "Task not found" });
	});

	it("fails without touching the cached task when no copy can be written", async () => {
		blockWrites(mainSpec, TASK_METADATA_FILE);
		writeFileSync(path.join(mainSpec, TASK_METADATA_FILE), "{}");

		const result = await invoke(IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE, "task-1", {
			mode: "compact",
		});

		expect(result).toEqual({ success: false, error: "Could not write task metadata" });
		expect(task.metadata).toBeUndefined();
		expect(state.logWarn).toHaveBeenCalledWith(
			expect.stringContaining(mainSpec),
			expect.anything(),
		);
	});
});
