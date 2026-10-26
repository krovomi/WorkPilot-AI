/**
 * The best-of-N handlers: the runner sets the variants up, the agent manager
 * builds them, the last exit ranks them, and nothing is adopted unasked.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { BestOfNState } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as unknown[][],
	runs: [] as string[][],
	reply: (_args: string[]): unknown => ({ error: "no reply set" }),
	task: undefined as unknown,
	project: undefined as unknown,
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (_command: string, args: string[]) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		state.runs.push(args);
		setImmediate(() => {
			child.stdout.write(`noise\n${JSON.stringify(state.reply(args))}\n`);
			child.emit("close", 0);
		});
		return child;
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () => ({ task: state.task, project: state.project }),
}));
vi.mock("../../../python-env-manager", () => ({
	pythonEnvManager: { getPythonPath: () => "python3" },
}));
vi.mock("../../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, []],
}));
vi.mock("../../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async () => ({ PATH: "/usr/bin" }),
}));
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));
vi.mock("../../../app-logger", () => ({ appLog: { debug: vi.fn(), warn: vi.fn() } }));

import {
	isBestOfNVariant,
	parseRunnerOutput,
	readState,
	registerBestOfNHandlers,
	sanitizeEngines,
} from "../best-of-n-handlers";

class FakeAgentManager extends EventEmitter {
	running = new Set<string>();
	started: string[] = [];
	isRunning(id: string) {
		return this.running.has(id);
	}
	async startTaskExecution(id: string) {
		this.started.push(id);
		this.running.add(id);
	}
	haltTask(id: string) {
		this.running.delete(id);
		this.emit("exit", id, null);
		return true;
	}
	end(id: string, code: number) {
		this.running.delete(id);
		this.emit("exit", id, code);
	}
}

const ENGINES = [
	{ provider: "anthropic", model: "model-a", effort: "high" },
	{ provider: "openai", model: "model-b", effort: "medium" },
];

const agents = new FakeAgentManager();
const window = { webContents: { send: (...args: unknown[]) => state.sent.push(args) } };
registerBestOfNHandlers(agents as never, () => window as never);

const call = (channel: string, ...args: unknown[]) =>
	state.handlers.get(channel)?.({}, ...args) as Promise<{
		success: boolean;
		error?: string;
		data?: { state: BestOfNState | null; running: string[]; busy?: string };
	}>;

let root: string;
let specDir: string;
let taskCounter = 0;

function variants(spec: string): BestOfNState["variants"] {
	return ENGINES.map((engine, i) => ({
		index: i + 1,
		specId: `${spec}-bon${i + 1}`,
		engine: engine as never,
		exitCode: null,
	}));
}

/** The runner, as the backend answers: it writes the state, then prints it. */
function backend(spec: string) {
	return (args: string[]) => {
		const command = args[1];
		const file = path.join(specDir, "best_of_n.json");
		const current = existsState() ? JSON.parse(readFileSync(file, "utf-8")) : null;
		let next: BestOfNState;
		if (command === "prepare") {
			next = { parent: spec, phase: "running", createdAt: "now", variants: variants(spec) };
		} else if (command === "rank") {
			next = { ...current, phase: "ranked" };
		} else if (command === "adopt") {
			next = { ...current, phase: "adopted" };
		} else {
			next = { ...current, phase: "discarded" };
		}
		writeFileSync(file, JSON.stringify(next));
		return { state: next };
	};
}

function existsState() {
	try {
		readFileSync(path.join(specDir, "best_of_n.json"));
		return true;
	} catch {
		return false;
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Run a start to its end: the runner answers on a real tick, the spacing is fake. */
async function drive<T>(promise: Promise<T>): Promise<T> {
	let done = false;
	void promise.finally(() => {
		done = true;
	});
	while (!done) {
		await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(2000);
	}
	return promise;
}

describe("best-of-N handlers", () => {
	let spec: string;
	beforeEach(() => {
		// A fresh task each time: the handler keeps one run per task.
		taskCounter += 1;
		spec = `00${taskCounter}-login`;
		root = mkdtempSync(path.join(tmpdir(), "bon-"));
		specDir = path.join(root, ".workpilot", "specs", spec);
		mkdirSync(specDir, { recursive: true });
		state.sent = [];
		state.runs = [];
		state.reply = backend(spec);
		state.project = { id: "p1", path: root, autoBuildPath: ".workpilot" };
		state.task = { id: spec, specId: spec, projectId: "p1", status: "backlog" };
		agents.running.clear();
		agents.started = [];
		vi.useFakeTimers({ toFake: ["setTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps engines to what the runner accepts", () => {
		expect(sanitizeEngines(ENGINES)).toEqual(ENGINES);
		expect(sanitizeEngines(ENGINES.slice(0, 1))).toMatch(/between 2 and 4/);
		expect(sanitizeEngines([...ENGINES, ...ENGINES, ENGINES[0]])).toMatch(/between 2 and 4/);
		expect(sanitizeEngines([{ ...ENGINES[0], provider: "../x" }, ENGINES[1]])).toMatch(/provider/);
		expect(sanitizeEngines([{ ...ENGINES[0], model: "a\nb" }, ENGINES[1]])).toMatch(/model/);
		expect(sanitizeEngines("nope")).toMatch(/list/);
	});

	it("reads the runner's last JSON line", () => {
		expect(parseRunnerOutput('log\n{"error": "no"}\n')).toEqual({ error: "no" });
		expect(parseRunnerOutput("nothing")).toEqual({ error: "The best-of-N runner gave no answer" });
	});

	it("builds each variant, then ranks them when the last one ends", async () => {
		const result = await drive(call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES));

		expect(result.success).toBe(true);
		expect(state.runs[0]).toEqual(
			expect.arrayContaining(["prepare", "--spec-dir", specDir, "--variants", JSON.stringify(ENGINES)]),
		);
		expect(agents.started).toEqual([`${spec}-bon1`, `${spec}-bon2`]);
		expect(isBestOfNVariant(`${spec}-bon1`)).toBe(true);
		expect(isBestOfNVariant(spec)).toBe(false);

		agents.end(`${spec}-bon1`, 0);
		expect(readState(specDir)?.variants[0].exitCode).toBe(0);
		expect(state.runs.map((args) => args[1])).toEqual(["prepare"]);

		agents.end(`${spec}-bon2`, 1);
		vi.useRealTimers();
		await settle();
		expect(readState(specDir)?.variants[1].exitCode).toBe(1);
		expect(state.runs.map((args) => args[1])).toEqual(["prepare", "rank"]);
		expect(readState(specDir)?.phase).toBe("ranked");
		// Nothing was adopted on its own.
		expect(state.runs.some((args) => args[1] === "adopt")).toBe(false);
	});

	it("refuses a task that is running, or a second run", async () => {
		agents.running.add(spec);
		const busy = await call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES);
		expect(busy).toMatchObject({ success: false, error: expect.stringMatching(/running/) });
		agents.running.delete(spec);

		await drive(call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES));
		const second = await call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES);
		expect(second).toMatchObject({ success: false, error: expect.stringMatching(/already/) });
	});

	it("says the setup failed without starting a build", async () => {
		state.reply = () => ({ error: "the task already has a build" });
		const result = await call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES);
		expect(result).toEqual({ success: false, error: "the task already has a build" });
		expect(agents.started).toEqual([]);
	});

	it("marks a build the app no longer runs as interrupted", async () => {
		writeFileSync(
			path.join(specDir, "best_of_n.json"),
			JSON.stringify({ parent: spec, phase: "running", createdAt: "x", variants: variants(spec) }),
		);
		const result = await call(IPC_CHANNELS.TASK_BEST_OF_N_STATUS, spec);
		expect(result.data?.state?.variants.every((v) => v.interrupted)).toBe(true);
	});

	it("adopts only a variant of the run, and only once every build ended", async () => {
		await drive(call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES));

		const early = await call(IPC_CHANNELS.TASK_BEST_OF_N_ADOPT, spec, `${spec}-bon1`);
		expect(early).toMatchObject({ success: false, error: expect.stringMatching(/Wait/) });
		const stranger = await call(IPC_CHANNELS.TASK_BEST_OF_N_ADOPT, spec, "../../etc");
		expect(stranger).toMatchObject({ success: false, error: expect.stringMatching(/not part/) });

		agents.end(`${spec}-bon1`, 0);
		agents.end(`${spec}-bon2`, 0);
		vi.useRealTimers();
		await settle();
		const adopted = await call(IPC_CHANNELS.TASK_BEST_OF_N_ADOPT, spec, `${spec}-bon2`);
		expect(adopted.success).toBe(true);
		expect(state.runs.at(-1)).toEqual(expect.arrayContaining(["adopt", "--variant", `${spec}-bon2`]));
	});

	it("stops the builds before discarding", async () => {
		await drive(call(IPC_CHANNELS.TASK_BEST_OF_N_START, spec, ENGINES));
		vi.useRealTimers();

		const result = await call(IPC_CHANNELS.TASK_BEST_OF_N_DISCARD, spec);
		expect(result.success).toBe(true);
		expect(agents.running.size).toBe(0);
		const commands = state.runs.map((args) => args[1]);
		expect(commands).toEqual(["prepare", "discard"]);
		expect(readState(specDir)?.phase).toBe("discarded");
	});
});
