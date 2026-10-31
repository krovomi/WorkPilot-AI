/**
 * The repo bench handlers: the renderer names cards and engines, the runner
 * prepares, the agent manager builds a few at a time in copies outside the
 * project, each exit is judged once, and nothing the model did not cause
 * (a rate limit, a discard) is counted.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { BenchManifest, BenchStatus } from "../../../shared/types";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
	runs: [] as Array<{ args: string[]; env: Record<string, string> }>,
	reply: (_args: string[]): unknown => ({ error: "no reply set" }),
	tasks: [] as unknown[],
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		state.runs.push({ args, env: options.env });
		queueMicrotask(() => {
			child.stdout.write(`noise\n${JSON.stringify(state.reply(args))}\n`);
			child.stdout.end();
			setImmediate(() => child.emit("close", 0));
		});
		return child;
	},
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === "p1" ? { id: "p1", path: "/projects/app", autoBuildPath: ".workpilot" } : undefined,
		getTasks: () => state.tasks,
	},
}));
vi.mock("../../python-env-manager", () => ({
	pythonEnvManager: {
		getPythonPath: () => "python3",
		getPythonEnv: () => ({ PYTHONPATH: "/bundled" }),
	},
}));
vi.mock("../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, []],
}));
vi.mock("../../env-utils", () => ({
	getAugmentedEnv: () => ({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-test-0000", HOME: "/home/u" }),
}));
vi.mock("../../app-logger", () => ({ appLog: { debug: vi.fn(), warn: vi.fn() } }));

const dataDir = mkdtempSync(path.join(tmpdir(), "bench-data-"));
process.env.WORKPILOT_DATA_DIR = dataDir;
process.env.WORKPILOT_BENCH_CONCURRENCY = "2";

import {
	benchRoot,
	forRenderer,
	insideBenchRoot,
	isBenchBuild,
	newRunId,
	parseRunnerOutput,
	registerBenchHandlers,
	sanitizeCommits,
	sanitizeEngines,
	sanitizeSpecIds,
} from "../bench-handlers";

class FakeAgentManager extends EventEmitter {
	running = new Set<string>();
	started: Array<{ taskId: string; projectPath: string; specId: string; options: unknown }> = [];
	halted: string[] = [];
	isRunning(id: string) {
		return this.running.has(id);
	}
	async startTaskExecution(taskId: string, projectPath: string, specId: string, options: unknown) {
		this.started.push({ taskId, projectPath, specId, options });
		this.running.add(taskId);
	}
	haltTask(id: string) {
		this.halted.push(id);
		this.end(id, null);
		return true;
	}
	end(id: string, code: number | null) {
		this.running.delete(id);
		this.emit("exit", id, code);
	}
}

const agents = new FakeAgentManager();
const window = { webContents: { send: (...args: unknown[]) => state.sent.push(args) } };
registerBenchHandlers(agents as never, () => window as never);

type Result<T> = { success: boolean; error?: string; data?: T };
const call = <T>(channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<Result<T>>;

const ENGINES = [
	{ provider: "anthropic", model: "model-a", effort: "high" },
	{ provider: "openai", model: "model-b", effort: "medium" },
];

/** Finished cards, all updated at the same instant: the clock can tick between two cards. */
function finished(...ids: string[]) {
	const updatedAt = new Date().toISOString();
	state.tasks = ids.map((specId) => ({
		id: specId,
		specId,
		title: `Card ${specId}`,
		status: "done",
		updatedAt,
	}));
}

/** The runner as the backend answers: a manifest that follows the judgements. */
function backend(builds: number, copyOf = (n: number) => path.join(benchRoot(), "k", "r", "builds", `b${n}`)) {
	let manifest: BenchManifest | null = null;
	return (args: string[]) => {
		const command = args[1];
		const runId = args[args.indexOf("--run-id") + 1];
		if (command === "discover") {
			const specs = JSON.parse(args[args.indexOf("--specs") + 1]) as string[];
			return { data: { cases: specs.map((caseId) => ({ caseId, status: "candidate" })) } };
		}
		if (command === "prepare") {
			manifest = {
				runId,
				createdAt: "now",
				phase: "running",
				engines: ENGINES.map((e, i) => ({ ...e, id: `v${i + 1}` })),
				cases: [{ caseId: "001-a", status: "ready" }],
				builds: Array.from({ length: builds }, (_, i) => ({
					id: `b${i + 1}`,
					caseId: "001-a",
					engineId: "v1",
					taskId: `bench-${runId.toLowerCase()}-b${i + 1}`,
					copy: copyOf(i + 1),
					state: "pending" as const,
				})),
			};
			return { data: manifest };
		}
		if (command === "judge" && manifest) {
			const id = args[args.indexOf("--build") + 1];
			const build = manifest.builds.find((b) => b.id === id);
			if (build) build.state = "judged";
			if (manifest.builds.every((b) => b.state !== "pending")) manifest.phase = "done";
			return { data: manifest };
		}
		if (command === "discard" && manifest) {
			manifest.phase = "discarded";
			return { data: manifest };
		}
		return { error: "unexpected" };
	};
}

/** Fake time, with the real event loop turned between steps (spawn closes on setImmediate). */
async function tick(ms: number) {
	const step = 50;
	for (let elapsed = 0; elapsed <= ms; elapsed += step) {
		for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed) || 0);
	}
}

const judgeCalls = () => state.runs.filter((r) => r.args[1] === "judge").map((r) => r.args);
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	state.runs = [];
	state.sent = [];
	agents.started = [];
	agents.halted = [];
	agents.running.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("requests from the renderer", () => {
	it("keeps 1 to 4 distinct, well-formed engines", () => {
		expect(sanitizeEngines(ENGINES)).toEqual(ENGINES);
		expect(sanitizeEngines([])).toMatch(/between 1 and 4/);
		expect(sanitizeEngines([ENGINES[0], ENGINES[0]])).toMatch(/twice/);
		expect(sanitizeEngines([{ ...ENGINES[0], provider: "Bad One" }])).toMatch(/provider/);
		expect(sanitizeEngines([{ ...ENGINES[0], model: "a\nb" }])).toMatch(/model/);
	});

	it("takes only finished cards of the project", () => {
		const tasks = [
			{ specId: "001-a", status: "done" },
			{ specId: "002-b", status: "pr_created" },
			{ specId: "003-c", status: "in_progress" },
		] as never;
		expect(sanitizeSpecIds(["001-a", "002-b", "001-a"], tasks)).toEqual(["001-a", "002-b"]);
		expect(sanitizeSpecIds(["003-c"], tasks)).toMatch(/finished/);
		expect(sanitizeSpecIds(["../x"], tasks)).toMatch(/Invalid/);
		expect(sanitizeSpecIds(Array.from({ length: 21 }, (_, i) => `${i}`), tasks)).toMatch(
			/between 1 and 20/,
		);
	});

	it("takes commits only for chosen cards, as hexadecimal", () => {
		expect(sanitizeCommits({ "001-a": " ABCDEF1 " }, ["001-a"])).toEqual({ "001-a": "abcdef1" });
		expect(sanitizeCommits({ "002-b": "abcdef1" }, ["001-a"])).toMatch(/not chosen/);
		expect(sanitizeCommits({ "001-a": "HEAD~1" }, ["001-a"])).toMatch(/hexadecimal/);
		expect(sanitizeCommits(undefined, [])).toEqual({});
	});

	it("starts a build only in a copy inside the bench folder", () => {
		expect(insideBenchRoot(path.join(benchRoot(), "k", "r", "builds", "b1"))).toBe(true);
		expect(insideBenchRoot(benchRoot())).toBe(false);
		expect(insideBenchRoot(path.join(benchRoot(), "..", "elsewhere"))).toBe(false);
		expect(insideBenchRoot("/projects/app")).toBe(false);
		expect(insideBenchRoot("relative/b1")).toBe(false);
	});

	it("never hands the renderer the path of a copy", () => {
		const manifest = {
			runId: "r",
			createdAt: "now",
			phase: "running",
			engines: [],
			cases: [],
			builds: [{ id: "b1", caseId: "c", engineId: "v1", taskId: "t", copy: "/secret/place", state: "pending" }],
		} as BenchManifest;
		expect(JSON.stringify(forRenderer(manifest))).not.toContain("/secret/place");
	});

	it("reads the runner's last JSON line and names run ids as the backend does", () => {
		expect(parseRunnerOutput('log\n{"data": {"x": 1}}\n')).toEqual({ data: { x: 1 } });
		expect(parseRunnerOutput('{"error": "no"}')).toEqual({ error: "no" });
		expect(parseRunnerOutput("nothing")).toEqual({ error: "The bench runner gave no answer" });
		expect(newRunId(new Date("2026-10-26T17:05:09Z"))).toMatch(/^20261026T170509-[0-9a-f]{6}$/);
	});
});

describe("a run", () => {
	it("builds two at a time, judges each exit once, and ends", async () => {
		finished("001-a");
		state.reply = backend(3);
		const started = await call<BenchStatus>(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], ENGINES, {});
		expect(started.success).toBe(true);
		expect(started.data?.busy).toBe("preparing");
		await tick(10);

		const prepare = state.runs.find((r) => r.args[1] === "prepare");
		expect(prepare).toBeDefined();
		expect(flag(prepare?.args ?? [], "--project-dir")).toBe("/projects/app");
		expect(JSON.parse(flag(prepare?.args ?? [], "--engines"))).toEqual(ENGINES);
		// No credential reaches the runner: it calls no model.
		expect(prepare?.env.OPENAI_API_KEY).toBeUndefined();
		expect(prepare?.env.PYTHONPATH.split(path.delimiter)[0]).toContain("backend");

		await tick(1600);
		expect(agents.started).toHaveLength(2);
		const [first] = agents.started;
		expect(first.projectPath.startsWith(benchRoot())).toBe(true);
		expect(first.specId).toBe("001-a");
		expect(first.options).toEqual({ useWorktree: false, envProjectPath: "/projects/app" });
		expect(isBenchBuild(first.taskId)).toBe(true);

		const status = await call<BenchStatus>(IPC_CHANNELS.BENCH_STATUS, "p1");
		expect(status.data?.running).toHaveLength(2);
		expect(status.data?.queued).toBe(1);

		agents.end(first.taskId, 0);
		await tick(2100);
		const [judged] = judgeCalls();
		expect(flag(judged, "--build")).toBe("b1");
		expect(flag(judged, "--outcome")).toBe("ended");
		expect(flag(judged, "--exit-code")).toBe("0");
		await tick(1600);
		expect(agents.started).toHaveLength(3);

		// A rate limit says nothing about the model: stopped, not counted.
		agents.emit("sdk-rate-limit", { taskId: agents.started[1].taskId });
		expect(agents.halted).toEqual([agents.started[1].taskId]);
		await tick(2100);
		expect(flag(judgeCalls()[1], "--outcome")).toBe("interrupted");

		agents.end(agents.started[2].taskId, 1);
		await tick(2100);
		expect(judgeCalls()).toHaveLength(3);
		const ended = await call<BenchStatus>(IPC_CHANNELS.BENCH_STATUS, "p1");
		expect(ended.data?.activeRunId).toBeNull();
	});

	it("does not judge a build the profile swap restarted", async () => {
		finished("001-a");
		state.reply = backend(1);
		await call(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], [ENGINES[0]], {});
		await tick(10);
		const [build] = agents.started;
		agents.end(build.taskId, 1);
		agents.running.add(build.taskId); // respawned in place
		await tick(2100);
		expect(judgeCalls()).toHaveLength(0);
		agents.end(build.taskId, 0);
		await tick(2100);
		expect(judgeCalls()).toHaveLength(1);
	});

	it("never starts a build in a copy outside the bench folder", async () => {
		finished("001-a");
		state.reply = backend(1, () => "/projects/app");
		await call(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], [ENGINES[0]], {});
		await tick(50);
		expect(agents.started).toHaveLength(0);
		expect(flag(judgeCalls()[0], "--outcome")).toBe("not-started");
	});

	it("refuses a second run, an unfinished card and an unknown project", async () => {
		finished("001-a");
		state.reply = backend(2);
		await call(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], ENGINES, {});
		const second = await call(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], ENGINES, {});
		expect(second.error).toMatch(/already/);
		const status = await call<BenchStatus>(IPC_CHANNELS.BENCH_STATUS, "p1");
		await call(IPC_CHANNELS.BENCH_DISCARD, "p1", status.data?.activeRunId);
		expect((await call(IPC_CHANNELS.BENCH_START, "p1", ["009-x"], ENGINES, {})).error).toMatch(
			/finished/,
		);
		expect((await call(IPC_CHANNELS.BENCH_START, "nope", ["001-a"], ENGINES, {})).error).toMatch(
			/not found/,
		);
	});

	it("discards: stops the builds, counts none, and frees the project", async () => {
		finished("001-a");
		state.reply = backend(2);
		await call(IPC_CHANNELS.BENCH_START, "p1", ["001-a"], ENGINES, {});
		await tick(1600);
		expect(agents.started).toHaveLength(2);
		const status = await call<BenchStatus>(IPC_CHANNELS.BENCH_STATUS, "p1");
		const discarding = call<BenchStatus>(IPC_CHANNELS.BENCH_DISCARD, "p1", status.data?.activeRunId);
		await tick(3000);
		const discarded = await discarding;
		expect(discarded.success).toBe(true);
		expect(agents.halted).toHaveLength(2);
		expect(judgeCalls().map((args) => flag(args, "--outcome"))).toEqual([
			"interrupted",
			"interrupted",
		]);
		expect(state.runs.at(-1)?.args[1]).toBe("discard");
		expect(discarded.data?.activeRunId).toBeNull();
		expect((await call(IPC_CHANNELS.BENCH_DISCARD, "p1", "../x")).error).toMatch(/Invalid/);
	});

	it("lists finished cards with what discovery found", async () => {
		finished("001-a", "002-b");
		state.reply = backend(0);
		const result = await call<Array<{ specId: string; title: string; case: { status: string } }>>(
			IPC_CHANNELS.BENCH_CANDIDATES,
			"p1",
		);
		expect(result.data?.map((c) => [c.specId, c.title, c.case.status])).toEqual([
			["001-a", "Card 001-a", "candidate"],
			["002-b", "Card 002-b", "candidate"],
		]);
	});

	it("lists the most recently finished cards first", async () => {
		finished("001-a", "002-b");
		(state.tasks[1] as { updatedAt: string }).updatedAt = new Date(Date.now() + 60_000).toISOString();
		state.reply = backend(0);
		const result = await call<Array<{ specId: string }>>(IPC_CHANNELS.BENCH_CANDIDATES, "p1");
		expect(result.data?.map((c) => c.specId)).toEqual(["002-b", "001-a"]);
	});
});
