/**
 * @vitest-environment node
 *
 * Opening a task's pull request over IPC. The backend (`run.py --create-pr`)
 * is a stand-in Node script that records its arguments and environment and
 * prints a JSON line like the real one, so the handler is checked end to
 * end: arguments validated and passed (custom body through a temporary file,
 * removed afterwards), the project's `.workpilot/.env` forwarded, the PR URL
 * and status written to both copies of the spec, the CI/CD pipeline and the
 * visual proof started for a new PR only, and failures passed on.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	serverCard: null as unknown,
	fakeSpawn: null as null | (() => unknown),
	cicd: null as unknown,
	cicdCalls: [] as unknown[][],
	proofCalls: [] as unknown[],
	kills: 0,
}));

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
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.serverCard }));
vi.mock("../../../server-board-review", () => ({
	createServerCardPR: vi.fn(async (_card: unknown, options: unknown) => ({
		success: true,
		data: { success: true, prUrl: "https://server/pr/1", options },
	})),
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
	visualProofService: {
		run: vi.fn(async (input: unknown) => {
			state.proofCalls.push(input);
			return { status: "passed", screenshots: [] };
		}),
	},
}));
vi.mock("../../cicd-triggers-handlers", () => ({
	autoTriggerForTask: vi.fn(async (...args: unknown[]) => {
		state.cicdCalls.push(args);
		return state.cicd;
	}),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerWorktreeCreatePRHandlers } from "../worktree-create-pr-handlers";

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
const createPR = (options?: Record<string, unknown>): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR, {}, "task-1", options);

const SPEC = "001-feature";
const sent: unknown[][] = [];
let windowShown: unknown = { webContents: { send: (...a: unknown[]) => sent.push(a) } };
const pythonEnvManager = {
	isEnvReady: () => state.envReady,
	initialize: vi.fn(async () => ({ ready: false, error: undefined })),
};
registerWorktreeCreatePRHandlers(pythonEnvManager as never, () => windowShown as never);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const specDir = () => path.join(state.root, ".workpilot", "specs", SPEC);
const worktreeDir = () => path.join(state.root, ".workpilot", "worktrees", "tasks", SPEC);
const worktreeSpecDir = () => path.join(worktreeDir(), ".workpilot", "specs", SPEC);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

function scenario(s: { stdout?: string[]; stderr?: string; code?: number }): void {
	writeFileSync(path.join(state.base, "backend", "scenario.json"), JSON.stringify(s), "utf-8");
}

function backendCall(): { argv: string[]; env: Record<string, string>; body?: string } {
	return readJson(path.join(state.base, "backend", "call.json"));
}

function fakeProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
	return Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
}

beforeEach(() => {
	state.base = mkdtempSync(path.join(tmpdir(), "wt-create-pr-"));
	state.root = path.join(state.base, "repo");
	mkdirSync(state.root);
	git(state.root, "init", "-q", "-b", "main");
	// Windows runners check out CRLF otherwise, and the tests compare bytes.
	git(state.root, "config", "core.autocrlf", "false");
	git(state.root, "config", "user.email", "test@example.invalid");
	git(state.root, "config", "user.name", "Test");
	git(state.root, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(state.root, ".gitignore"), ".workpilot/\n", "utf-8");
	git(state.root, "add", ".gitignore");
	git(state.root, "commit", "-q", "-m", "init");
	git(state.root, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktreeDir());
	for (const dir of [specDir(), worktreeSpecDir()]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "implementation_plan.json"),
			JSON.stringify({ status: "human_review" }),
			"utf-8",
		);
	}
	writeFileSync(
		path.join(state.root, ".workpilot", ".env"),
		"AZURE_DEVOPS_ORG_URL=https://dev.azure.com/example\n",
		"utf-8",
	);

	const backend = path.join(state.base, "backend");
	mkdirSync(backend);
	writeFileSync(
		path.join(backend, "run.py"),
		`const fs = require("node:fs");
const path = require("node:path");
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario.json"), "utf8"));
const argv = process.argv.slice(2);
const bodyAt = argv.indexOf("--pr-body-file");
fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify({
	argv,
	body: bodyAt >= 0 ? fs.readFileSync(argv[bodyAt + 1], "utf8") : undefined,
	env: {
		AZURE_DEVOPS_ORG_URL: process.env.AZURE_DEVOPS_ORG_URL,
		GITHUB_CLI_PATH: process.env.GITHUB_CLI_PATH,
		APP_LANGUAGE: process.env.APP_LANGUAGE,
	},
}));
for (const chunk of sc.stdout || []) process.stdout.write(chunk);
if (sc.stderr) process.stderr.write(sc.stderr);
process.exitCode = sc.code || 0;
`,
		"utf-8",
	);
	state.source = backend;
	state.envReady = true;
	state.serverCard = null;
	state.fakeSpawn = null;
	state.cicd = null;
	state.cicdCalls = [];
	state.proofCalls = [];
	state.kills = 0;
	state.project = {
		id: "p1",
		name: "Project",
		path: state.root,
		autoBuildPath: ".workpilot",
		settings: {},
	};
	state.tasks = [{ id: "task-1", specId: SPEC, title: "Feature", status: "human_review" }];
	sent.length = 0;
	windowShown = { webContents: { send: (...a: unknown[]) => sent.push(a) } };
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DEBUG;
	rmSync(state.base, { recursive: true, force: true });
});

describe("TASK_WORKTREE_CREATE_PR", () => {
	it("hands a server card to the server", async () => {
		state.serverCard = { id: "srv" };
		expect((await createPR({ draft: true })).data).toEqual({
			success: true,
			prUrl: "https://server/pr/1",
			options: { draft: true },
		});
	});

	it("stops before the backend when Python, the task, the source, the spec or the worktree are missing", async () => {
		state.envReady = false;
		expect((await createPR()).error).toBe("Python environment not ready: Unknown error");
		state.envReady = true;
		state.tasks = [];
		expect((await createPR()).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: SPEC }];
		state.source = null;
		expect((await createPR()).error).toBe("WorkPilot AI source not found");
		state.source = path.join(state.base, "backend");
		git(state.root, "worktree", "remove", "--force", worktreeDir());
		expect((await createPR()).error).toBe("No worktree found for this task");
		rmSync(specDir(), { recursive: true });
		expect((await createPR()).error).toBe("Spec directory not found");
		expect(existsSync(path.join(state.base, "backend", "call.json"))).toBe(false);
	});

	it("refuses a bad branch name or title, and removes the body file it wrote", async () => {
		const before = new Set(
			(await import("node:fs")).readdirSync(tmpdir()).filter((n) => n.startsWith("workpilot-pr-body-")),
		);
		expect(await createPR({ targetBranch: "x; rm -rf /", customBody: "body" })).toEqual({
			success: false,
			error: "Invalid target branch name",
		});
		expect((await createPR({ title: "t".repeat(257) })).error).toBe(
			"PR title exceeds maximum length of 256 characters",
		);
		expect((await createPR({ title: "bad\u0007title" })).error).toBe(
			"PR title contains invalid characters",
		);
		const after = (await import("node:fs"))
			.readdirSync(tmpdir())
			.filter((n) => n.startsWith("workpilot-pr-body-") && !before.has(n));
		expect(after).toEqual([]);
	});

	it("opens the PR, records it on both copies of the task, starts the pipeline and the visual proof", async () => {
		writeFileSync(
			path.join(specDir(), "task_metadata.json"),
			JSON.stringify({ baseBranch: "main" }),
			"utf-8",
		);
		state.cicd = { provider: "github", status: "queued" };
		scenario({
			stdout: [
				"Pushing branch...\n",
				`${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/7" })}\n`,
			],
		});

		const result = await createPR({
			targetBranch: "main",
			title: "Add the feature",
			draft: true,
			customBody: "## Summary\nDone.",
			allowCrossReviewDisagreement: true,
			includeWalkthrough: true,
		});

		expect(result).toEqual({
			success: true,
			data: {
				success: true,
				prUrl: "https://github.com/o/r/pull/7",
				error: undefined,
				alreadyExists: undefined,
				visualProof: { status: "passed", screenshots: [] },
			},
		});
		const call = backendCall();
		const bodyFile = call.argv[call.argv.indexOf("--pr-body-file") + 1];
		expect(call.argv).toEqual([
			"--spec",
			SPEC,
			"--project-dir",
			state.root,
			"--create-pr",
			"--pr-target",
			"main",
			"--pr-title",
			"Add the feature",
			"--pr-draft",
			"--pr-body-file",
			bodyFile,
			"--pr-ignore-cross-review",
			"--base-branch",
			"main",
		]);
		expect(call.body).toBe("## Summary\nDone.");
		expect(existsSync(bodyFile)).toBe(false);
		expect(call.env).toEqual({
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/example",
			GITHUB_CLI_PATH: "gh",
			APP_LANGUAGE: "en",
		});

		for (const dir of [specDir(), worktreeSpecDir()]) {
			expect(readJson(path.join(dir, "implementation_plan.json")).status).toBe("done");
			const metadata = readJson(path.join(dir, "task_metadata.json"));
			expect(metadata.prUrl).toBe("https://github.com/o/r/pull/7");
			expect(metadata.visualProof).toEqual({ status: "passed", screenshots: [] });
			expect(metadata.cicdRun).toEqual({ provider: "github", status: "queued" });
		}
		expect(state.cicdCalls[0]?.[1]).toBe("pr");
		expect(state.cicdCalls[0]?.[2]).toEqual({
			prUrl: "https://github.com/o/r/pull/7",
			branch: `workpilot/${SPEC}`,
			taskId: "task-1",
			specId: SPEC,
		});
		expect(state.proofCalls[0]).toMatchObject({ includeWalkthrough: true, specId: SPEC });
		expect(sent.map((s) => s.slice(0, 2))).toEqual([
			[IPC_CHANNELS.TASK_UPDATED_EVENT, "task-1"],
			[IPC_CHANNELS.TASK_UPDATED_EVENT, "task-1"],
		]);
	});

	it("refreshes the task when the PR already existed, without a pipeline or a proof when none is asked", async () => {
		windowShown = null;
		scenario({
			stdout: [
				`${JSON.stringify({ success: true, prUrl: "https://github.com/o/r/pull/7", alreadyExists: true })}\n`,
			],
		});
		const result = await createPR({ runVisualProof: false });
		expect(result.data).toMatchObject({ success: true, alreadyExists: true, visualProof: undefined });
		expect(state.cicdCalls).toEqual([]);
		expect(state.proofCalls).toEqual([]);
		expect(readJson(path.join(specDir(), "task_metadata.json")).prUrl).toBe(
			"https://github.com/o/r/pull/7",
		);
		expect(backendCall().argv).not.toContain("--pr-ignore-cross-review");
	});

	it("starts no pipeline when the settings ask for none, and keeps going without a window", async () => {
		windowShown = null;
		scenario({
			stdout: [`${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/8" })}\n`],
		});
		const result = await createPR();
		expect(result.data?.prUrl).toBe("https://github.com/o/r/pull/8");
		expect(state.cicdCalls).toHaveLength(1);
		expect(readJson(path.join(specDir(), "task_metadata.json")).cicdRun).toBeUndefined();
	});

	it("ignores a PR URL that is not https, and succeeds on silent output", async () => {
		scenario({ stdout: [`${JSON.stringify({ success: true, pr_url: "javascript:alert(1)" })}\n`] });
		const result = await createPR();
		expect(result.data).toMatchObject({ success: true, prUrl: undefined });
		expect(state.proofCalls).toEqual([]);
		expect(readJson(path.join(specDir(), "implementation_plan.json")).status).toBe("human_review");

		scenario({ stdout: ["Done.\n"] });
		expect(await createPR()).toEqual({ success: true, data: { success: true, prUrl: undefined } });
	});

	it("passes on the backend's error, a cross-review hold, or its raw output", async () => {
		scenario({ stdout: [`${JSON.stringify({ success: false, error: "gh: not logged in" })}\n`], code: 1 });
		expect(await createPR()).toEqual({ success: false, error: "gh: not logged in" });

		scenario({
			stdout: [
				`${JSON.stringify({ success: false, error: "held", cross_review_blocked: true })}\n`,
			],
			code: 1,
		});
		expect(await createPR()).toEqual({
			success: false,
			error: "held",
			data: { success: false, error: "held", crossReviewBlocked: true },
		});

		scenario({ stdout: [`${JSON.stringify({ success: false })}\n`], code: 1 });
		expect((await createPR()).error).toBe("Failed to create PR");

		scenario({ stderr: "\u001b[31mfatal: no remote\u001b[0m", code: 128 });
		expect((await createPR()).error).toBe("fatal: no remote");

		scenario({ code: 1 });
		expect((await createPR()).error).toBe("Failed to create PR");
	});

	it("fails cleanly when the body cannot be written", async () => {
		const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
		const missing = path.join(state.base, "no-such-tmp");
		process.env.TMPDIR = missing;
		process.env.TMP = missing;
		process.env.TEMP = missing;
		try {
			expect(await createPR({ customBody: "x" })).toEqual({
				success: false,
				error: "Failed to write custom PR body to temporary file",
			});
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("reports a backend that cannot start, answers from exit when close never comes", async () => {
		state.fakeSpawn = () => {
			const proc = fakeProcess();
			queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
			return proc;
		};
		expect(await createPR()).toEqual({ success: false, error: "Failed to run create-pr: ENOENT" });

		state.fakeSpawn = () => {
			const proc = fakeProcess();
			queueMicrotask(() => {
				proc.stdout.emit("data", Buffer.from("no json\n"));
				proc.emit("exit", 0);
				setTimeout(() => proc.emit("error", new Error("late")), 150);
			});
			return proc;
		};
		expect(await createPR()).toEqual({ success: true, data: { success: true, prUrl: undefined } });
		await new Promise((r) => setTimeout(r, 200));
	});

	it("gives up after the timeout and says to check GitHub", async () => {
		vi.useFakeTimers();
		let proc: ReturnType<typeof fakeProcess> | undefined;
		state.fakeSpawn = () => {
			proc = fakeProcess();
			return proc;
		};
		const pending = createPR();
		await vi.waitFor(() => expect(proc).toBeDefined());
		await vi.advanceTimersByTimeAsync(120000);
		expect(await pending).toEqual({
			success: false,
			error: "PR creation timed out. Check if the PR was created on GitHub.",
		});
		expect(state.kills).toBe(1);
		proc?.emit("close", 0);
	});

	it("logs each step when DEBUG is set", async () => {
		process.env.DEBUG = "true";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		writeFileSync(
			path.join(specDir(), "task_metadata.json"),
			JSON.stringify({ baseBranch: "main" }),
			"utf-8",
		);
		state.cicd = { provider: "github", status: "queued" };
		scenario({
			stdout: [`${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/9" })}\n`],
			stderr: "warning\n",
		});
		await createPR();
		scenario({ stdout: [`${JSON.stringify({ success: true, pr_url: "https://github.com/o/r/pull/9", already_exists: true })}\n`] });
		await createPR();
		scenario({ stdout: [`${JSON.stringify({ success: false, error: "x" })}\n`], code: 1 });
		await createPR();
		scenario({ stdout: ["plain\n"] });
		await createPR();
		git(state.root, "worktree", "remove", "--force", worktreeDir());
		await createPR();
		rmSync(specDir(), { recursive: true });
		await createPR();
		state.tasks = [];
		await createPR();
		expect(warn.mock.calls.filter((c) => c[0] === "[CREATE_PR DEBUG]").length).toBeGreaterThan(10);
		warn.mockRestore();
	});

	it("returns an unexpected error as a failed result", async () => {
		// A NUL byte in a stored path: stat refuses it on every OS, and not
		// with ENOENT (a file inside a file is ENOTDIR on POSIX, ENOENT on Windows).
		state.project = { ...state.project, autoBuildPath: ".workpilot\0bad" };
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = await createPR();
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/null bytes/);
		error.mockRestore();
	});
});
