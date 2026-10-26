/**
 * The PR follow-through handlers: the renderer names a task, the main process
 * reads everything else from the task record and forwards the runner's lines.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
	spawned: [] as { command: string; args: string[]; env: unknown }[],
	child: null as null | (EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: () => void;
	}),
	task: undefined as unknown,
	project: undefined as unknown,
	worktree: "/p/.workpilot/worktrees/tasks/001-x" as string | null,
	pythonPath: "python3" as string | null,
	runnerEnvOptions: [] as unknown[],
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[], opts: { env: unknown }) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => child.emit("close", null)),
		});
		state.child = child;
		state.spawned.push({ command, args, env: opts.env });
		return child;
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () => ({ task: state.task, project: state.project }),
}));
vi.mock("../../../worktree-paths", () => ({
	findTaskWorktree: () => state.worktree,
}));
vi.mock("../../../python-env-manager", () => ({
	pythonEnvManager: { getPythonPath: () => state.pythonPath },
}));
vi.mock("../../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, []],
}));
vi.mock("../../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (_backend: string, options: unknown) => {
		state.runnerEnvOptions.push(options);
		return { PATH: "/usr/bin" };
	},
}));
vi.mock("../../../agent/task-provider-env", () => ({
	readTaskMetadataFor: () => ({ provider: "openai" }),
	taskEngineFromMetadata: () => ({ qa: { provider: "openai" } }),
	planTaskProviders: () => ({
		providers: ["openai"],
		startProvider: "openai",
		usesClaude: false,
	}),
}));
vi.mock("../../../app-logger", () => ({ appLog: { debug: vi.fn() } }));

import {
	buildFollowupArgs,
	parseFollowupLine,
	registerPrFollowupHandlers,
	sanitizeFollowupOptions,
	stopAllPrFollowups,
} from "../pr-followup-handlers";

const ROUND = {
	decision: "fix",
	reason: "to fix: 1 failing check(s)",
	action: "fixed",
	head_sha: "a".repeat(40),
	pushed_sha: "b".repeat(40),
	detail: "",
	failing: ["unit"],
	base_failing: [],
	threads: [],
	violations: [],
	finished: false,
};

const window = { webContents: { send: (...args: unknown[]) => state.sent.push(args) } };
registerPrFollowupHandlers(() => window as never);

const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<{
		success: boolean;
		error?: string;
		data?: { running: boolean };
	}>;

describe("PR follow-through handlers", () => {
	beforeEach(() => {
		stopAllPrFollowups();
		state.sent = [];
		state.spawned = [];
		state.runnerEnvOptions = [];
		state.worktree = "/p/.workpilot/worktrees/tasks/001-x";
		state.pythonPath = "python3";
		state.project = { id: "p1", path: "/p", autoBuildPath: ".workpilot" };
		state.task = {
			id: "t1",
			specId: "001-x",
			metadata: { prUrl: "https://github.com/acme/app/pull/7" },
		};
	});

	it("refuses a task without a PR, and a missing worktree", async () => {
		state.task = { id: "t1", specId: "001-x", metadata: {} };
		expect((await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1")).success).toBe(false);
		state.task = { id: "t1", specId: "001-x", prUrl: "https://github.com/acme/app/pull/7" };
		state.worktree = null;
		expect((await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1")).success).toBe(false);
		expect(state.spawned).toEqual([]);
	});

	it("refuses a task id that is not a string", async () => {
		const result = await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, { id: "t1" });
		expect(result.success).toBe(false);
	});

	it("starts the runner on the task's record and its own providers", async () => {
		const result = await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1", {
			maxRounds: 99,
			fixReviewThreads: false,
		});
		expect(result.success).toBe(true);
		expect(result.data?.running).toBe(true);
		const { args } = state.spawned[0];
		expect(args).toContain("--pr-url");
		expect(args[args.indexOf("--pr-url") + 1]).toBe("https://github.com/acme/app/pull/7");
		expect(args[args.indexOf("--max-rounds") + 1]).toBe("10");
		expect(args).toContain("--no-review-threads");
		expect(state.runnerEnvOptions[0]).toEqual({
			taskProviders: { providers: ["openai"], startProvider: "openai", usesClaude: false },
		});
	});

	it("does not start a second runner for the same task", async () => {
		await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1");
		await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1");
		expect(state.spawned).toHaveLength(1);
	});

	it("forwards each round and the end of the run", async () => {
		await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1");
		const child = state.child;
		child?.stdout.write("noise from the fixer\n");
		child?.stdout.write(`${JSON.stringify({ event: "round", round: ROUND })}\n`);
		await new Promise((r) => setImmediate(r));
		child?.emit("close", 0);
		const events = state.sent.filter((e) => e[0] === IPC_CHANNELS.TASK_PR_FOLLOWUP_EVENT);
		expect(events.at(-1)).toEqual([
			IPC_CHANNELS.TASK_PR_FOLLOWUP_EVENT,
			"t1",
			{ running: false, round: ROUND, error: undefined },
		]);
		const status = await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_STATUS, "t1");
		expect(status.data).toEqual({ running: false, round: ROUND, error: undefined });
	});

	it("says why a run ended without a round", async () => {
		await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, "t1");
		state.child?.stdout.write('{"error": "only GitHub pull requests can be followed"}\n');
		await new Promise((r) => setImmediate(r));
		state.child?.emit("close", 2);
		const status = await call(IPC_CHANNELS.TASK_PR_FOLLOWUP_STATUS, "t1");
		expect(status.data).toEqual({
			running: false,
			round: undefined,
			error: "only GitHub pull requests can be followed",
		});
	});
});

describe("runner line parsing and arguments", () => {
	it("reads rounds, results and errors, and ignores anything else", () => {
		expect(parseFollowupLine("plain text")).toBeNull();
		expect(parseFollowupLine("{not json")).toBeNull();
		expect(parseFollowupLine('{"event": "round", "round": {}}')).toBeNull();
		expect(parseFollowupLine(JSON.stringify({ result: ROUND }))).toEqual({
			round: ROUND,
			final: true,
		});
		expect(parseFollowupLine('{"error": "x"}')).toEqual({ error: "x" });
	});

	it("bounds the options", () => {
		expect(sanitizeFollowupOptions(undefined)).toEqual({ maxRounds: 3, fixReviewThreads: true });
		expect(sanitizeFollowupOptions({ maxRounds: -1 }).maxRounds).toBe(3);
		expect(sanitizeFollowupOptions({ maxRounds: 1.5 }).maxRounds).toBe(3);
		expect(sanitizeFollowupOptions({ maxRounds: 0 }).maxRounds).toBe(0);
		expect(sanitizeFollowupOptions("x")).toEqual({ maxRounds: 3, fixReviewThreads: true });
	});

	it("passes every value as its own argument", () => {
		const args = buildFollowupArgs({
			runnerPath: "/b/runners/pr_followup_runner.py",
			projectPath: "/p q",
			specDir: "/p q/.workpilot/specs/001-x",
			specId: "001-x",
			worktreePath: "/p q/.workpilot/worktrees/tasks/001-x",
			prUrl: "https://github.com/acme/app/pull/7",
			options: { maxRounds: 2, fixReviewThreads: true },
		});
		expect(args[args.indexOf("--project-dir") + 1]).toBe("/p q");
		expect(args).not.toContain("--no-review-threads");
	});
});
