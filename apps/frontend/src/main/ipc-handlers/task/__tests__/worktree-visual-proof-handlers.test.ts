/**
 * @vitest-environment node
 *
 * Visual proof over IPC: a run recorded on both copies of the task and
 * announced to the window; the sync that looks for a PR on the branch
 * through the backend (`run.py --find-pr`, a stand-in Node script here),
 * links the task to it without marking it done and publishes the captures
 * already taken; the running state forwarded to every window.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	base: "",
	root: "",
	source: "" as string | null,
	envReady: true,
	project: {} as Record<string, unknown>,
	tasks: [] as Array<Record<string, unknown>>,
	fakeSpawn: null as null | (() => unknown),
	runError: null as Error | null,
	kills: 0,
}));

const service = vi.hoisted(() => {
	const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
	return Object.assign(new Emitter(), {
		runs: [] as unknown[],
		published: [] as unknown[][],
		running: new Set<string>(),
		publishToPr: async (
			proof: unknown,
			prUrl: string,
			worktree?: string,
		): Promise<Record<string, unknown>> => {
			// Replaced by the mock below; the type is what the tests swap.
			return { proof, prUrl, worktree };
		},
	});
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn((...args: Parameters<typeof actual.spawn>) =>
			state.fakeSpawn ? state.fakeSpawn() : actual.spawn(...args),
		),
	};
});
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (name: string) => name }));
vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [state.project], getTasks: () => state.tasks },
}));
vi.mock("../../../python-env-manager", () => ({
	getConfiguredPythonPath: () => process.execPath,
	pythonEnvManager: { getPythonEnv: () => ({}) },
}));
vi.mock("../../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => ({ env: {} }),
}));
vi.mock("../../../updater/path-resolver", () => ({
	getEffectiveSourcePath: () => state.source,
}));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "en" }));
vi.mock("../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../platform")>()),
	killProcessGracefully: () => {
		state.kills += 1;
	},
}));
vi.mock("../../../visual-proof-service", () => ({
	visualProofService: Object.assign(service, {
		run: async (input: unknown) => {
			if (state.runError) throw state.runError;
			service.runs.push(input);
			return { status: "passed", screenshots: ["a.png"] };
		},
		publishToPr: async (proof: unknown, prUrl: string, worktree?: string) => {
			service.published.push([proof, prUrl, worktree]);
			return { status: "passed", screenshots: ["a.png"], prUrl };
		},
		isRunning: (taskId: string) => service.running.has(taskId),
	}),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerWorktreeVisualProofHandlers } from "../worktree-visual-proof-handlers";

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const SPEC = "001-feature";
const sent: unknown[][] = [];
let windowShown: unknown = null;
const pythonEnvManager = {
	isEnvReady: () => state.envReady,
	initialize: vi.fn(async () => ({ ready: false, error: "x" })),
};
registerWorktreeVisualProofHandlers(pythonEnvManager as never, () => windowShown as never);
// Registering again does not stack a second forwarder.
registerWorktreeVisualProofHandlers(pythonEnvManager as never, () => windowShown as never);

const specDir = () => path.join(state.root, ".workpilot", "specs", SPEC);
const worktreeDir = () => path.join(state.root, ".workpilot", "worktrees", "tasks", SPEC);
const worktreeSpecDir = () => path.join(worktreeDir(), ".workpilot", "specs", SPEC);
const metadataOf = (dir: string) =>
	JSON.parse(readFileSync(path.join(dir, "task_metadata.json"), "utf-8"));

function scenario(s: { stdout?: string[]; code?: number }): void {
	writeFileSync(path.join(state.base, "backend", "scenario.json"), JSON.stringify(s), "utf-8");
}

beforeEach(() => {
	state.base = mkdtempSync(path.join(tmpdir(), "wt-proof-"));
	state.root = path.join(state.base, "repo");
	mkdirSync(state.root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: state.root });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Test");
	git("commit", "-q", "--allow-empty", "-m", "init");
	git("worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktreeDir());
	mkdirSync(specDir(), { recursive: true });
	mkdirSync(worktreeSpecDir(), { recursive: true });
	writeFileSync(
		path.join(specDir(), "task_metadata.json"),
		JSON.stringify({ baseBranch: "main" }),
		"utf-8",
	);

	const backend = path.join(state.base, "backend");
	mkdirSync(backend);
	writeFileSync(
		path.join(backend, "run.py"),
		`const fs = require("node:fs");
const path = require("node:path");
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario.json"), "utf8"));
fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify(process.argv.slice(2)));
for (const chunk of sc.stdout || []) process.stdout.write(chunk);
process.exitCode = sc.code || 0;
`,
		"utf-8",
	);
	state.source = backend;
	state.envReady = true;
	state.fakeSpawn = null;
	state.runError = null;
	state.kills = 0;
	state.project = { id: "p1", path: state.root, autoBuildPath: ".workpilot", settings: {} };
	state.tasks = [{ id: "task-1", specId: SPEC, metadata: {} }];
	service.runs = [];
	service.published = [];
	service.running.clear();
	sent.length = 0;
	windowShown = { webContents: { send: (...a: unknown[]) => sent.push(a) } };
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(state.base, { recursive: true, force: true });
});

describe("TASK_VISUAL_PROOF_RUN", () => {
	it("refuses an unknown task", async () => {
		state.tasks = [];
		expect(await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, "task-1")).toEqual({
			success: false,
			error: "Task not found",
		});
	});

	it("runs with the task's PR, records the result on both copies and tells the window", async () => {
		state.tasks = [{ id: "task-1", specId: SPEC, metadata: { prUrl: "https://github.com/o/r/pull/1" } }];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, "task-1");
		expect(result).toEqual({ success: true, data: { status: "passed", screenshots: ["a.png"] } });
		expect(service.runs[0]).toMatchObject({
			taskId: "task-1",
			specId: SPEC,
			prUrl: "https://github.com/o/r/pull/1",
			worktreePath: path.resolve(worktreeDir()),
		});
		for (const dir of [specDir(), worktreeSpecDir()]) {
			expect(metadataOf(dir).visualProof).toEqual({ status: "passed", screenshots: ["a.png"] });
		}
		expect(sent).toEqual([
			[
				IPC_CHANNELS.TASK_UPDATED_EVENT,
				"task-1",
				{ metadata: { visualProof: { status: "passed", screenshots: ["a.png"] } } },
				"p1",
			],
		]);
		warn.mockRestore();
	});

	it("runs without a PR or a worktree or a window, and passes on a failure", async () => {
		windowShown = null;
		state.project = { ...state.project, autoBuildPath: undefined };
		execFileSync("git", ["worktree", "remove", "--force", worktreeDir()], { cwd: state.root });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, "task-1")).success).toBe(true);
		expect(service.runs[0]).toMatchObject({ prUrl: undefined, worktreePath: undefined });
		expect(sent).toEqual([]);

		state.runError = new Error("emulator did not start");
		expect(await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, "task-1")).toEqual({
			success: false,
			error: "emulator did not start",
		});
		state.runError = "odd" as never;
		expect((await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_RUN, "task-1")).error).toBe(
			"Failed to run visual proof",
		);
		warn.mockRestore();
	});
});

describe("TASK_VISUAL_PROOF_SYNC", () => {
	const sync = () => invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_SYNC, "task-1");

	it("refuses an unknown task, and has nothing to do for a task already linked", async () => {
		state.tasks = [];
		expect((await sync()).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: SPEC, prUrl: "https://github.com/o/r/pull/1" }];
		expect(await sync()).toEqual({ success: true, data: {} });
		expect(service.published).toEqual([]);
	});

	it("links the PR found on the branch and publishes the captures already taken", async () => {
		const proof = { status: "passed", screenshots: ["a.png"] };
		state.tasks = [{ id: "task-1", specId: SPEC, metadata: { visualProof: proof } }];
		scenario({
			stdout: ["looking...\n", `${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/5" })}\n`],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await sync();
		expect(result).toEqual({
			success: true,
			data: {
				prUrl: "https://github.com/o/r/pull/5",
				visualProof: { ...proof, prUrl: "https://github.com/o/r/pull/5" },
			},
		});
		const argv = JSON.parse(readFileSync(path.join(state.base, "backend", "call.json"), "utf-8"));
		expect(argv.slice(-3)).toEqual(["--find-pr", "--pr-target", "main"]);
		expect(service.published[0]).toEqual([proof, "https://github.com/o/r/pull/5", path.resolve(worktreeDir())]);
		for (const dir of [specDir(), worktreeSpecDir()]) {
			const metadata = metadataOf(dir);
			expect(metadata.prUrl).toBe("https://github.com/o/r/pull/5");
			expect(metadata.visualProof.prUrl).toBe("https://github.com/o/r/pull/5");
		}
		warn.mockRestore();
	});

	it("links the PR without publishing when nothing was captured, and without a worktree", async () => {
		execFileSync("git", ["worktree", "remove", "--force", worktreeDir()], { cwd: state.root });
		writeFileSync(path.join(specDir(), "task_metadata.json"), "{}", "utf-8");
		scenario({ stdout: [`${JSON.stringify({ success: true, prUrl: "https://github.com/o/r/pull/6" })}\n`] });
		expect(await sync()).toEqual({
			success: true,
			data: { prUrl: "https://github.com/o/r/pull/6", visualProof: undefined },
		});
		const argv = JSON.parse(readFileSync(path.join(state.base, "backend", "call.json"), "utf-8"));
		expect(argv).not.toContain("--pr-target");
	});

	it("finds no PR when the backend says none, cannot run, or Python is not ready", async () => {
		scenario({ stdout: [`${JSON.stringify({ success: true })}\n`] });
		expect(await sync()).toEqual({ success: true, data: {} });
		scenario({ stdout: ["garbage"], code: 1 });
		expect(await sync()).toEqual({ success: true, data: {} });

		state.source = null;
		expect(await sync()).toEqual({ success: true, data: {} });
		state.envReady = false;
		expect(await sync()).toEqual({ success: true, data: {} });
	});

	it("finds no PR when the process fails to start, throws, or hangs", async () => {
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
			queueMicrotask(() => {
				proc.emit("error", new Error("ENOENT"));
				proc.emit("close", 1);
			});
			return proc;
		};
		expect(await sync()).toEqual({ success: true, data: {} });

		state.fakeSpawn = () => {
			throw new Error("EINVAL");
		};
		expect(await sync()).toEqual({ success: true, data: {} });

		vi.useFakeTimers();
		let started = false;
		state.fakeSpawn = () => {
			started = true;
			return Object.assign(new EventEmitter(), { stdout: null });
		};
		const pending = sync();
		await vi.waitFor(() => expect(started).toBe(true));
		await vi.advanceTimersByTimeAsync(45000);
		expect(await pending).toEqual({ success: true, data: {} });
		expect(state.kills).toBe(1);
	});

	it("passes on an error while linking", async () => {
		// A folder where the metadata file should be: the URL cannot be saved,
		// and publishing then fails for this test's service.
		state.tasks = [{ id: "task-1", specId: SPEC, metadata: { visualProof: {} } }];
		scenario({ stdout: [`${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/7" })}\n`] });
		const original = service.publishToPr;
		service.publishToPr = async () => {
			throw new Error("gh refused");
		};
		const result = await sync();
		service.publishToPr = original;
		expect(result).toEqual({ success: false, error: "gh refused" });
		service.publishToPr = async () => {
			throw 1;
		};
		expect((await sync()).error).toBe("Failed to sync visual proof");
		service.publishToPr = original;
	});
});

describe("running state", () => {
	it("answers whether a run is live and forwards changes to the window", async () => {
		service.running.add("task-1");
		expect(await invoke(IPC_CHANNELS.TASK_VISUAL_PROOF_STATUS, "task-1")).toEqual({
			success: true,
			data: { running: true },
		});
		expect(service.listenerCount("running-changed")).toBe(1);
		service.emit("running-changed", "task-1", false);
		expect(sent).toEqual([[IPC_CHANNELS.TASK_VISUAL_PROOF_RUNNING, "task-1", false]]);
		windowShown = null;
		service.emit("running-changed", "task-1", true);
		expect(sent).toHaveLength(1);
	});
});
