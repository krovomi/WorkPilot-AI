/**
 * @vitest-environment node
 *
 * Resuming, switching and re-running a task, on real spec folders: the
 * RESUME signal in the spec and in the worktree, a resume on another engine
 * written locked into every copy of the metadata (Claude's session kept only
 * from Claude to Claude, a formula dropped once it no longer holds), a phase
 * re-run that rewinds every plan, clears the logs and markers and lifts the
 * pause, the live hot swap marker, and the conversation reset. Arguments
 * from the renderer are checked again here.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	found: {} as { task?: unknown; project?: unknown },
	settings: undefined as Record<string, unknown> | undefined,
	resume: vi.fn(async () => ({ success: true })),
	watch: vi.fn(),
	unwatch: vi.fn(),
	invalidate: vi.fn(),
	logError: vi.fn(),
	logWarn: vi.fn(),
}));

vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => state.settings }));
vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: state.watch, unwatch: state.unwatch } }));
vi.mock("../../../project-store", () => ({ projectStore: { invalidateTasksCache: state.invalidate } }));
vi.mock("../../../task-state-manager", () => ({ taskStateManager: {} }));
vi.mock("../resume-task", async (importOriginal) => ({
	...(await importOriginal<typeof import("../resume-task")>()),
	resumePausedTask: state.resume,
}));
vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: state.logWarn, error: state.logError },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Task } from "../../../../shared/types";
import { registerTaskResumeHandlers } from "../execution-resume-handlers";
import { resumeTaskWithProvider } from "../resume-with-provider";

type Result = { success: boolean; error?: string };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const agent = {
	running: false,
	startsProcess: true,
	isRunning: vi.fn(() => agent.running),
	killTask: vi.fn(() => {
		agent.running = false;
	}),
	startSpecCreation: vi.fn(async () => {
		agent.running = agent.startsProcess;
	}),
	startTaskExecution: vi.fn(async () => {
		agent.running = agent.startsProcess;
	}),
};
const sent: unknown[][] = [];
registerTaskResumeHandlers({
	agentManager: agent as never,
	getMainWindow: () => ({ webContents: { send: (...a: unknown[]) => sent.push(a) } }) as never,
});

let base = "";
let projectDir = "";
let specDir = "";
let wtSpecDir = "";

function setTask(over: Partial<Task> = {}): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "Add login",
		description: "Users sign in",
		status: "human_review",
		subtasks: [],
		metadata: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
		...over,
	} as Task;
	state.found = { task, project: { id: "p1", path: projectDir } };
	return task;
}

function addWorktree(): string {
	wtSpecDir = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x", ".workpilot", "specs", "001-x");
	mkdirSync(wtSpecDir, { recursive: true });
	return wtSpecDir;
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
const write = (file: string, data: unknown) => writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), "utf-8");

beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-resume-"));
	projectDir = path.join(base, "project");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	mkdirSync(specDir, { recursive: true });
	state.found = {};
	state.settings = undefined;
	agent.running = false;
	agent.startsProcess = true;
	sent.length = 0;
	vi.clearAllMocks();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_RESUME_PAUSED", () => {
	it("answers for an unknown task", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1")).toEqual({ success: false, error: "Task not found" });
	});

	it("writes RESUME in the spec and in the worktree the build runs in", async () => {
		setTask();
		addWorktree();
		expect(await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1")).toEqual({ success: true });
		for (const dir of [specDir, wtSpecDir]) {
			expect(read(path.join(dir, "RESUME"))).toMatchObject({ resumed_by: "user" });
		}
	});

	it("is content with the main spec when the worktree copy cannot be written", async () => {
		setTask();
		// The worktree exists, its spec folder does not.
		mkdirSync(path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x"), { recursive: true });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1")).success).toBe(true);
		expect(warn).toHaveBeenCalledWith("[TASK_RESUME_PAUSED] Could not write to worktree (non-fatal):", expect.anything());
		warn.mockRestore();
	});

	it("warns about a paused build with no worktree, and uses the task's own spec path", async () => {
		const own = path.join(base, "own-spec");
		mkdirSync(own);
		setTask({ specsPath: own, executionProgress: { phase: "rate_limit_paused" } } as Partial<Task>);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1")).success).toBe(true);
		expect(existsSync(path.join(own, "RESUME"))).toBe(true);
		expect(warn.mock.calls[0][0]).toMatch(/Worktree not found for paused task 001-x/);

		setTask({ executionProgress: { phase: "auth_failure_paused" } } as Partial<Task>);
		await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1");
		expect(warn).toHaveBeenCalledTimes(2);
		setTask({ executionProgress: { phase: "coding" } } as Partial<Task>);
		await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1");
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("fails when the signal cannot be written", async () => {
		setTask();
		rmSync(specDir, { recursive: true });
		const result = await invoke(IPC_CHANNELS.TASK_RESUME_PAUSED, "t1");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/ENOENT/);
	});
});

describe("TASK_RESUME_WITH_PROVIDER", () => {
	const resume = (...args: unknown[]) => invoke(IPC_CHANNELS.TASK_RESUME_WITH_PROVIDER, "t1", ...args);

	it("checks the task and the provider", async () => {
		expect(await resume("ollama")).toEqual({ success: false, error: "Task not found" });
		setTask();
		for (const bad of [undefined, "", 42]) {
			expect(await resume(bad)).toEqual({ success: false, error: "Missing or invalid providerName argument" });
		}
	});

	it("moves the paused phase and the rest to the new engine, in every copy, without the Claude session", async () => {
		const task = setTask({
			metadata: {
				provider: "anthropic",
				model: "claude-sonnet-4-5-20250929",
				paused: { enabled: true, paused_phase: "coding" },
				appliedFormula: { provider: "anthropic", model: "claude-sonnet-4-5-20250929", effort: "medium" },
			} as Task["metadata"],
		});
		addWorktree();
		write(path.join(specDir, "task_metadata.json"), { note: "kept", appliedFormula: { provider: "anthropic" } });
		write(path.join(specDir, "RESUME_WITH_PROVIDER"), "old marker");

		expect(await resume("  ollama ", " qwen3:32b ", "high")).toEqual({ success: true });

		for (const dir of [specDir, wtSpecDir]) {
			const meta = read(path.join(dir, "task_metadata.json"));
			expect(meta.engineLocked).toBe(true);
			expect(meta.phaseProviders).toMatchObject({ coding: "ollama", qa: "ollama", spec: "anthropic", planning: "anthropic" });
			expect(meta.phaseModels).toMatchObject({ coding: "qwen3:32b", qa: "qwen3:32b" });
			expect(meta.phaseThinking).toMatchObject({ coding: "high", qa: "high" });
			expect(meta.appliedFormula).toBeUndefined();
		}
		expect(read(path.join(specDir, "task_metadata.json")).note).toBe("kept");
		expect(existsSync(path.join(specDir, "RESUME_WITH_PROVIDER"))).toBe(false);
		expect(task.metadata?.appliedFormula).toBeUndefined();
		expect(task.metadata?.provider).toBe("ollama");
		expect(state.resume).toHaveBeenCalledWith(agent, "t1", "p1", { keepSession: false });
	});

	it("limits the change to the paused phase when asked, and keeps a Claude session on Claude", async () => {
		setTask({ metadata: { provider: "anthropic", paused: { enabled: true, paused_phase: "planning" } } as Task["metadata"] });
		expect(await resume("claude", "", "bogus", "phase")).toEqual({ success: true });
		const meta = read(path.join(specDir, "task_metadata.json"));
		expect(meta.phaseProviders).toMatchObject({ planning: "claude", coding: "anthropic" });
		expect(state.resume).toHaveBeenCalledWith(agent, "t1", "p1", { keepSession: true });
	});

	it("drops the Claude session when the failover changed the account", async () => {
		setTask({ metadata: { provider: "anthropic", paused: { enabled: true, paused_phase: "coding" } } as Task["metadata"] });
		expect(await resumeTaskWithProvider(agent as never, "t1", "anthropic", { keepClaudeSession: false })).toEqual({
			success: true,
		});
		expect(state.resume).toHaveBeenCalledWith(agent, "t1", "p1", { keepSession: false });
	});

	it("fills an empty metadata copy", async () => {
		setTask();
		write(path.join(specDir, "task_metadata.json"), "");
		expect((await resume("ollama")).success).toBe(true);
		expect(read(path.join(specDir, "task_metadata.json")).engineLocked).toBe(true);
	});

	it("keeps a formula that still describes every phase", async () => {
		const formula = { provider: "ollama", model: "qwen3:32b", effort: "low" };
		const task = setTask({
			metadata: {
				engineLocked: true,
				provider: "ollama",
				phaseProviders: { spec: "ollama", planning: "ollama", coding: "ollama", qa: "ollama" },
				phaseModels: { spec: "qwen3:32b", planning: "qwen3:32b", coding: "qwen3:32b", qa: "qwen3:32b" },
				phaseThinking: { spec: "low", planning: "low", coding: "low", qa: "low" },
				appliedFormula: formula,
			} as Task["metadata"],
		});
		write(path.join(specDir, "task_metadata.json"), { appliedFormula: formula });
		// The task is still finishing its step: it is stopped first.
		agent.running = true;
		expect((await resume("ollama", "qwen3:32b", "low")).success).toBe(true);
		expect(agent.killTask).toHaveBeenCalledWith("t1");
		expect(task.metadata?.appliedFormula).toEqual(formula);
		expect(read(path.join(specDir, "task_metadata.json")).appliedFormula).toEqual(formula);
	});

	it("ignores a model or an effort that is not text", async () => {
		const task = setTask({ metadata: undefined });
		expect((await resume("ollama", { evil: true }, ["high"])).success).toBe(true);
		expect(task.metadata?.provider).toBe("ollama");
		expect(typeof task.metadata?.model).toBe("string");
	});

	it("reports a copy it cannot update and goes on", async () => {
		setTask();
		write(path.join(specDir, "task_metadata.json"), "{ broken");
		expect((await resume("ollama")).success).toBe(true);
		expect(state.logWarn).toHaveBeenCalledWith(
			expect.stringMatching(/^\[TASK_RESUME_WITH_PROVIDER\] Could not update /),
			expect.any(SyntaxError),
		);
	});

	it("fails when the engine cannot be worked out", async () => {
		setTask();
		// A provider whose presets cannot be read: the settings themselves throw.
		state.settings = new Proxy(
			{},
			{
				get() {
					throw new Error("settings unreadable");
				},
			},
		);
		expect(await resume("ollama")).toEqual({ success: false, error: "settings unreadable" });
		expect(state.resume).not.toHaveBeenCalled();
		state.settings = new Proxy(
			{},
			{
				get() {
					throw "plain";
				},
			},
		);
		expect(await resume("ollama")).toEqual({ success: false, error: "Failed to update the task engine" });
	});
});

describe("TASK_RERUN_PHASE", () => {
	const rerun = (phase: unknown) => invoke(IPC_CHANNELS.TASK_RERUN_PHASE, "t1", phase);

	function planFile(dir: string): string {
		const file = path.join(dir, "implementation_plan.json");
		write(file, {
			status: "human_review",
			phases: [{ name: "Implementation", subtasks: [{ id: "a", status: "completed" }] }],
			qa_signoff: { status: "approved" },
		});
		return file;
	}

	it("refuses an unknown phase or task", async () => {
		expect(await rerun("deploy")).toEqual({ success: false, error: "Invalid phase: deploy" });
		expect(await rerun("coding")).toEqual({ success: false, error: "Task not found" });
	});

	it("rewinds every plan, clears the logs, markers and pause, then restarts the build", async () => {
		const task = setTask({
			metadata: { provider: "ollama", baseBranch: "release", paused: { enabled: true } } as Task["metadata"],
		});
		addWorktree();
		const plans = [planFile(specDir), planFile(wtSpecDir)];
		write(path.join(specDir, "task_logs.json"), {
			phases: {
				planning: { phase: "planning", status: "completed", entries: [1] },
				validation: { status: "completed", entries: [1, 2] },
			},
		});
		write(path.join(specDir, "task_logs.qwen.json"), { phases: { coding: { phase: "coding", entries: [1] } } });
		write(path.join(specDir, "task_logs.other.json"), { phases: { planning: { entries: [1] } } });
		write(path.join(specDir, "task_logs.empty.json"), "");
		write(path.join(specDir, "task_logs.nophases.json"), { other: true });
		write(path.join(specDir, "task_logs.broken.json"), "{ broken");
		for (const marker of ["PROMPT_TOO_LONG_HALT", "PAUSE", "HOT_SWAP.json"]) write(path.join(wtSpecDir, marker), "x");

		expect(await rerun("coding")).toEqual({ success: true });

		expect(agent.killTask).toHaveBeenCalledWith("t1");
		for (const plan of plans) {
			expect(read(plan)).toMatchObject({
				status: "in_progress",
				executionPhase: "coding",
				qa_signoff: { status: "pending" },
				phases: [{ subtasks: [{ id: "a", status: "pending" }] }],
			});
		}
		const logs = read(path.join(specDir, "task_logs.json"));
		expect(logs.phases.planning.entries).toEqual([1]);
		expect(logs.phases.validation).toEqual({
			phase: "validation",
			status: "pending",
			started_at: null,
			completed_at: null,
			entries: [],
		});
		expect(read(path.join(specDir, "task_logs.qwen.json")).phases.coding.entries).toEqual([]);
		expect(read(path.join(specDir, "task_logs.other.json")).phases.planning.entries).toEqual([1]);
		expect(readFileSync(path.join(specDir, "task_logs.broken.json"), "utf-8")).toBe("{ broken");
		expect(readdirSync(wtSpecDir).filter((n) => /HALT|PAUSE$|HOT_SWAP/.test(n))).toEqual([]);
		expect(read(path.join(specDir, "pause_state.json")).enabled).toBe(false);
		expect(task.metadata?.paused?.enabled).toBe(false);
		expect(state.invalidate).toHaveBeenCalledWith("p1");
		expect(agent.startTaskExecution).toHaveBeenCalledWith(
			"t1",
			projectDir,
			"001-x",
			{ useWorktree: true, baseBranch: "release" },
			"p1",
		);
	});

	it("re-runs the planning from the spec pipeline, even without a plan", async () => {
		setTask({ description: "", metadata: { useWorktree: false } as Task["metadata"] });
		(state.found.project as { settings?: unknown }).settings = { mainBranch: "trunk" };
		write(path.join(specDir, "implementation_plan.json"), "{ broken");
		expect(await rerun("planning")).toEqual({ success: true });
		expect(state.watch).toHaveBeenCalledWith("t1", specDir);
		expect(agent.startSpecCreation).toHaveBeenCalledWith("t1", projectDir, "Add login", specDir, expect.anything(), "trunk", "p1");
	});

	it("wants a plan to re-run the coding or the validation", async () => {
		setTask();
		expect(await rerun("validation")).toEqual({
			success: false,
			error: "No implementation plan found to re-run. Start the task first.",
		});
		expect(agent.startTaskExecution).not.toHaveBeenCalled();
	});

	it("puts the task back in human review when the build does not start", async () => {
		setTask();
		const plan = planFile(specDir);
		agent.startsProcess = false;
		expect(await rerun("validation")).toEqual({
			success: false,
			error: "The task process did not start. Check the task error and application logs.",
		});
		expect(read(plan).status).toBe("human_review");
		expect(sent).toEqual([[IPC_CHANNELS.TASK_STATUS_CHANGE, "t1", "human_review", "p1"]]);
		expect(state.unwatch).toHaveBeenCalledTimes(2);

		agent.startTaskExecution.mockRejectedValueOnce("plain");
		expect(await rerun("coding")).toEqual({ success: false, error: "Failed to re-run phase" });
	});
});

describe("TASK_HOT_SWAP", () => {
	const swap = (phase: unknown, change: unknown) => invoke(IPC_CHANNELS.TASK_HOT_SWAP, "t1", phase, change);

	it("checks the phase, the change and the task", async () => {
		expect(await swap("deploy", { model: "m" })).toEqual({ success: false, error: "Invalid phase: deploy" });
		expect(await swap("coding", undefined)).toEqual({ success: false, error: "No change provided" });
		expect(await swap("coding", {})).toEqual({ success: false, error: "No change provided" });
		expect(await swap("coding", { model: ["m"] })).toEqual({ success: false, error: "Invalid change" });
		expect(await swap("coding", { model: "m", provider: 3 })).toEqual({ success: false, error: "Invalid change" });
		expect(await swap("coding", { model: "m" })).toEqual({ success: false, error: "Task not found" });
	});

	it("writes the marker once in every spec folder that exists", async () => {
		setTask();
		addWorktree();
		expect(await swap("qa", { provider: "ollama", effort: "high" })).toEqual({ success: true });
		for (const dir of [specDir, wtSpecDir]) {
			expect(read(path.join(dir, "HOT_SWAP.json"))).toMatchObject({
				phase: "qa",
				provider: "ollama",
				model: null,
				effort: "high",
			});
		}
	});

	it("fails when no marker could be written", async () => {
		setTask();
		mkdirSync(path.join(specDir, `HOT_SWAP.json.${process.pid}.tmp`));
		expect(await swap("coding", { model: "m" })).toEqual({ success: false, error: "Could not write hot-swap marker" });
		expect(state.logWarn).toHaveBeenCalledWith(expect.stringMatching(/^\[TASK_HOT_SWAP\] Could not write marker in /), expect.anything());
		rmSync(specDir, { recursive: true });
		expect(await swap("coding", { model: "m" })).toEqual({ success: false, error: "Could not write hot-swap marker" });
	});
});

describe("TASK_RESET_CONVERSATION", () => {
	const reset = () => invoke(IPC_CHANNELS.TASK_RESET_CONVERSATION, "t1");

	it("removes the transcripts and halt markers, and nothing else", async () => {
		expect(await reset()).toEqual({ success: false, error: "Task not found" });
		setTask();
		for (const name of [
			"conversation.jsonl",
			"PROMPT_TOO_LONG_HALT",
			"LOCAL_MODEL_NO_TOOLS_HALT",
			"conversation.qwen3.jsonl",
			"conversation.jsonl.migrated",
			"implementation_plan.json",
			"conversation.txt",
		]) {
			write(path.join(specDir, name), "x");
		}
		expect(await reset()).toEqual({ success: true });
		expect(readdirSync(specDir).sort()).toEqual(["conversation.txt", "implementation_plan.json"]);
	});

	it("is fine with a spec folder that is gone, and keeps going past a log it cannot delete", async () => {
		setTask();
		rmSync(specDir, { recursive: true });
		expect(await reset()).toEqual({ success: true });

		mkdirSync(path.join(specDir, "conversation.a.jsonl"), { recursive: true });
		expect(await reset()).toEqual({ success: true });
		expect(existsSync(path.join(specDir, "conversation.a.jsonl"))).toBe(true);
	});

	it("fails when the main transcript cannot be removed", async () => {
		setTask();
		mkdirSync(path.join(specDir, "conversation.jsonl"));
		const result = await reset();
		expect(result.success).toBe(false);
		expect(state.logError).toHaveBeenCalledWith("[TASK_RESET_CONVERSATION] failed for task t1:", expect.anything());
	});
});
