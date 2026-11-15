/**
 * @vitest-environment node
 *
 * Recovering a stuck task (shown as running, with no process), on a real
 * project and repository: a running task is refused, the new status follows
 * the plan's subtasks (or the one asked for), failed subtasks go back to
 * pending while the interrupted one is kept, every copy of the plan is
 * written, and a restart picks the right phase up again only after the same
 * checks as a start. A task that died before it had a plan recovers too.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	found: {} as { task?: unknown; project?: unknown },
	hasValidAuth: true,
	initError: null as unknown,
	watch: vi.fn(),
	unwatch: vi.fn(),
	invalidate: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: () => "git",
	getToolPathAsync: async () => "git",
}));
vi.mock("../../../file-watcher", () => ({
	fileWatcher: { watch: state.watch, unwatch: state.unwatch },
}));
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: state.invalidate, getTasks: () => [] },
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: { getCurrentState: () => undefined, clearTask: vi.fn() },
}));
vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => undefined }));
vi.mock("../../../learning-loop-service", () => ({
	learningLoopService: { recordTaskOutcome: vi.fn() },
}));
vi.mock("../../../claude-profile-manager", () => ({
	initializeClaudeProfileManager: async () => {
		if (state.initError !== null) throw state.initError;
		return { hasValidAuth: () => state.hasValidAuth };
	},
}));
vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: state.logError },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Task } from "../../../../shared/types";
import { registerTaskRecoveryHandlers } from "../execution-recovery-handlers";

type Data = { taskId: string; recovered: boolean; newStatus: string; message: string; autoRestarted?: boolean };
type Result = { success: boolean; error?: string; data?: Data };
const recover = (options?: unknown): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(IPC_CHANNELS.TASK_RECOVER_STUCK, {}, "t1", options);

const agent = {
	running: false,
	isRunning: vi.fn(() => agent.running),
	startSpecCreation: vi.fn(),
	startTaskExecution: vi.fn(),
};
const sent: unknown[][] = [];
let windowOpen = true;
registerTaskRecoveryHandlers({
	agentManager: agent as never,
	getMainWindow: () =>
		windowOpen ? ({ webContents: { send: (...a: unknown[]) => sent.push(a) } } as never) : null,
});

let base = "";
let projectDir = "";
let specDir = "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setTask(over: Partial<Task> = {}): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "Add login",
		description: "Users sign in",
		status: "in_progress",
		subtasks: [],
		metadata: { provider: "ollama" },
		...over,
	} as Task;
	state.found = { task, project: { id: "p1", path: projectDir } };
	return task;
}

type Sub = { id: string; status: string; actual_output?: string; started_at?: string; completed_at?: string };
function writePlan(subtasks: Sub[], dir = specDir): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "implementation_plan.json");
	writeFileSync(file, JSON.stringify({ status: "in_progress", phases: [{ subtasks }] }), "utf-8");
	return file;
}
const readPlan = (dir = specDir) =>
	JSON.parse(readFileSync(path.join(dir, "implementation_plan.json"), "utf-8"));

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-recover-"));
	projectDir = path.join(base, "project");
	mkdirSync(projectDir);
	git(projectDir, "init", "-q");
	git(projectDir, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	state.hasValidAuth = true;
	state.initError = null;
	agent.running = false;
	windowOpen = true;
	sent.length = 0;
	vi.clearAllMocks();
	spies = [
		vi.spyOn(console, "warn").mockImplementation(() => undefined),
		vi.spyOn(console, "error").mockImplementation(() => undefined),
	];
});
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_RECOVER_STUCK", () => {
	it("refuses a task that is still running, and an unknown one", async () => {
		agent.running = true;
		expect(await recover()).toEqual({
			success: false,
			error: "Task is still running. Stop it first before recovering.",
			data: { taskId: "t1", recovered: false, newStatus: "in_progress", message: "Task is still running" },
		});
		agent.running = false;
		expect(await recover()).toEqual({ success: false, error: "Task not found" });
	});

	it("refuses a plan that is not JSON, or that it cannot read", async () => {
		setTask();
		mkdirSync(specDir, { recursive: true });
		writeFileSync(path.join(specDir, "implementation_plan.json"), "{ broken", "utf-8");
		const corrupted = {
			success: false,
			error: "Plan file contains invalid JSON. The file may be corrupted.",
		};
		expect(await recover()).toEqual(corrupted);
		expect(state.logError).toHaveBeenCalledWith(
			"[Recovery] Failed to parse plan file as JSON:",
			expect.any(SyntaxError),
		);
		rmSync(path.join(specDir, "implementation_plan.json"));
		mkdirSync(path.join(specDir, "implementation_plan.json"));
		expect(await recover()).toEqual(corrupted);
	});

	it("recovers a task that died before it had a plan, back to the backlog", async () => {
		setTask();
		mkdirSync(specDir, { recursive: true });
		const result = await recover();
		expect(result).toEqual({
			success: true,
			data: {
				taskId: "t1",
				recovered: true,
				newStatus: "backlog",
				message: "Task recovered successfully and moved to backlog",
				autoRestarted: false,
			},
		});
		expect(readPlan()).toMatchObject({
			feature: "Add login",
			description: "Users sign in",
			status: "backlog",
			planStatus: "pending",
			phases: [],
		});
		expect(state.unwatch).toHaveBeenCalledWith("t1");
		expect(sent).toEqual([[IPC_CHANNELS.TASK_STATUS_CHANGE, "t1", "backlog", "p1"]]);
	});

	it("resumes in progress when some subtasks are done, and resets the failed ones only", async () => {
		setTask();
		writePlan([
			{ id: "a", status: "completed" },
			{ id: "b", status: "in_progress", started_at: "t0" },
			{ id: "c", status: "failed", actual_output: "boom", started_at: "t0", completed_at: "t1" },
		]);
		const result = await recover({ autoRestart: false });
		expect(result.data?.newStatus).toBe("in_progress");
		const plan = readPlan();
		expect(plan.planStatus).toBe("in_progress");
		expect(plan.recoveryNote).toMatch(/^Task recovered from stuck state at /);
		expect(plan.phases[0].subtasks).toEqual([
			{ id: "a", status: "completed" },
			{ id: "b", status: "in_progress", started_at: "t0" },
			{ id: "c", status: "pending" },
		]);
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("goes back to the backlog when nothing was done, and honours the status asked for", async () => {
		setTask();
		writePlan([{ id: "a", status: "pending" }]);
		windowOpen = false;
		expect((await recover()).data?.newStatus).toBe("backlog");
		expect(sent).toEqual([]);

		for (const [target, planStatus] of [
			["done", "completed"],
			["ai_review", "review"],
			["human_review", "review"],
			["in_progress", "in_progress"],
		] as const) {
			expect((await recover({ targetStatus: target })).data?.newStatus).toBe(target);
			expect(readPlan().planStatus).toBe(planStatus);
		}
	});

	it("sends a finished task to human review, without restarting it, in every copy", async () => {
		setTask();
		writePlan([{ id: "a", status: "completed" }]);
		const worktreeSpec = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x", ".workpilot", "specs", "001-x");
		writePlan([{ id: "a", status: "completed" }], worktreeSpec);

		expect(await recover({ autoRestart: true })).toEqual({
			success: true,
			data: {
				taskId: "t1",
				recovered: true,
				newStatus: "human_review",
				message: "Task is complete and ready for review",
				autoRestarted: false,
			},
		});
		expect(readPlan()).toMatchObject({ status: "human_review", planStatus: "review" });
		expect(readPlan(worktreeSpec)).toMatchObject({ status: "human_review", planStatus: "review" });
		expect(agent.startTaskExecution).not.toHaveBeenCalled();
	});

	// atomicWriteFileSync writes `<plan>.<pid>.tmp` first: a folder there makes the write fail.
	const blockWrites = (dir = specDir) =>
		mkdirSync(path.join(dir, `implementation_plan.json.${process.pid}.tmp`), { recursive: true });

	it("fails when no copy of the plan can be written", async () => {
		setTask();
		writePlan([{ id: "a", status: "pending" }]);
		blockWrites();
		expect(await recover()).toEqual({ success: false, error: "Failed to write plan file during recovery" });
		expect(state.unwatch).not.toHaveBeenCalled();
	});

	it("fails a finished task's recovery when no copy can be written", async () => {
		setTask();
		writePlan([{ id: "a", status: "completed" }]);
		blockWrites();
		expect(await recover()).toEqual({
			success: false,
			error: "Failed to write plan file during recovery (all locations failed)",
		});
	});

	describe("with a restart", () => {
		it("restarts the build where it stopped, resuming its Claude session", async () => {
			setTask({ subtasks: [{ id: "a" }] as Task["subtasks"], metadata: { provider: "ollama", baseBranch: "release", tddMode: true } as Task["metadata"] });
			writePlan([
				{ id: "a", status: "completed" },
				{ id: "b", status: "pending" },
			]);
			writeFileSync(path.join(specDir, "spec.md"), "# Spec", "utf-8");
			writeFileSync(path.join(specDir, ".session.json"), JSON.stringify({ session_id: "sess-1" }));

			const result = await recover({ autoRestart: true });
			expect(result.data).toMatchObject({
				newStatus: "in_progress",
				message: "Task recovered and restarted successfully",
				autoRestarted: true,
			});
			expect(readPlan()).toMatchObject({ status: "in_progress", planStatus: "in_progress" });
			expect(state.watch).toHaveBeenCalledWith("t1", specDir);
			expect(agent.startTaskExecution).toHaveBeenCalledWith(
				"t1",
				projectDir,
				"001-x",
				expect.objectContaining({ baseBranch: "release", tddMode: true, resumeSessionId: "sess-1" }),
				"p1",
			);
			expect((state.found.task as Task).metadata?.engineLocked).toBe(true);
		});

		it("writes the spec again for a task that died before its plan", async () => {
			setTask({ description: "" });
			mkdirSync(specDir, { recursive: true });
			(state.found.project as { settings?: unknown }).settings = { mainBranch: "trunk" };
			const result = await recover({ autoRestart: true });
			expect(result.data?.autoRestarted).toBe(true);
			expect(agent.startSpecCreation).toHaveBeenCalledWith(
				"t1",
				projectDir,
				"Add login",
				specDir,
				expect.anything(),
				"trunk",
				"p1",
			);
		});

		it("does not restart without a repository, a profile manager or Claude auth", async () => {
			setTask({ metadata: { provider: "anthropic" } });
			mkdirSync(specDir, { recursive: true });
			state.hasValidAuth = false;
			expect((await recover({ autoRestart: true })).data?.autoRestarted).toBe(false);
			state.initError = new Error("EACCES");
			expect((await recover({ autoRestart: true })).data?.autoRestarted).toBe(false);
			rmSync(path.join(projectDir, ".git"), { recursive: true });
			writeFileSync(path.join(projectDir, ".git"), "gitdir: /nonexistent\n");
			const result = await recover({ autoRestart: true });
			expect(result.success).toBe(true);
			expect(result.data?.autoRestarted).toBe(false);
			expect(agent.startSpecCreation).not.toHaveBeenCalled();
		});

		it("restarts even when a copy of the plan cannot take the restart status", async () => {
			setTask();
			writePlan([{ id: "a", status: "pending" }]);
			const worktreeSpec = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x", ".workpilot", "specs", "001-x");
			writePlan([{ id: "a", status: "pending" }], worktreeSpec);
			// The worktree copy refuses every write: the main copy is enough.
			blockWrites(worktreeSpec);
			const result = await recover({ autoRestart: true });
			expect(result.data?.autoRestarted).toBe(true);
			expect(readPlan().status).toBe("in_progress");
			expect(state.logError).toHaveBeenCalledWith(
				expect.stringMatching(/^\[Recovery\] Failed to write plan file for restart at /),
				expect.anything(),
			);
		});

		it("reports a restart that fails", async () => {
			setTask();
			mkdirSync(specDir, { recursive: true });
			agent.startSpecCreation.mockImplementationOnce(() => {
				throw new Error("spawn failed");
			});
			const result = await recover({ autoRestart: true });
			expect(result.success).toBe(true);
			expect(result.data?.autoRestarted).toBe(false);
			expect(state.logError).toHaveBeenCalledWith(
				"Failed to auto-restart task after recovery:",
				expect.any(Error),
			);
		});
	});
});
