/**
 * @vitest-environment node
 *
 * The GitHub auto-fix, on a real project folder: the queue and the batches it
 * reads from `.workpilot/github`, the open issues whose labels ask for a fix,
 * starting a fix on one issue (a spec, its state file, the spec agent), and
 * the runner commands behind batching, previewing and approving batches.
 * GitHub and the Python runner are stand-ins.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RunOptions = {
	args: string[];
	env?: Record<string, string>;
	onProgress?: (percent: number, message: string) => void;
	onComplete?: (stdout: string, stderr: string) => unknown;
};

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	gh: null as null | { token: string; repo: string },
	fetch: vi.fn(),
	runs: [] as RunOptions[],
	run: { exitCode: 0, stdout: "", error: "" },
	validation: { valid: true, backendPath: "/backend" } as { valid: boolean; backendPath?: string; error?: string },
	onRun: undefined as undefined | ((options: RunOptions) => void),
}));

vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitHubConfig: () => state.gh,
	githubFetch: state.fetch,
}));
vi.mock("../utils/runner-env", () => ({ getRunnerEnv: async () => ({ RUNNER_ENV: "1" }) }));
vi.mock("../utils/subprocess-runner", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils/subprocess-runner")>()),
	validateGitHubModule: async () => state.validation,
	runPythonSubprocess: (options: RunOptions) => {
		state.runs.push(options);
		state.onRun?.(options);
		const { exitCode, stdout, error } = state.run;
		let result: { success: boolean; data?: unknown; error?: string };
		if (exitCode !== 0) {
			result = { success: false, error: error || undefined };
		} else {
			try {
				result = { success: true, data: options.onComplete?.(stdout, "") };
			} catch (e) {
				result = { success: false, error: (e as Error).message };
			}
		}
		return { process: {}, promise: Promise.resolve({ exitCode, stdout, stderr: "", ...result }) };
	},
}));

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent/agent-manager";
import { registerAutoFixHandlers } from "../autofix-handlers";

const mock = ipcMain as unknown as {
	invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
	emit: (c: string, ...a: unknown[]) => boolean;
};
const send = vi.fn();
const window = { webContents: { send } } as unknown as BrowserWindow;
let mainWindow: BrowserWindow | null = window;
const startSpecCreation = vi.fn();
registerAutoFixHandlers({ startSpecCreation } as unknown as AgentManager, () => mainWindow);

let projectDir: string;
const githubDir = () => path.join(projectDir, ".workpilot", "github");
const writeJson = (dir: string, name: string, data: unknown) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), JSON.stringify(data));
};
const enable = (labels = ["auto-fix"]) =>
	writeJson(githubDir(), "config.json", { auto_fix_enabled: true, auto_fix_labels: labels });
const sent = (channel: string) => send.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(2));
const invoke = (channel: string, ...args: unknown[]) => mock.invokeHandler(channel, {}, "p", ...args);

beforeEach(() => {
	projectDir = mkdtempSync(path.join(tmpdir(), "autofix-"));
	state.project = { id: "p", path: projectDir, autoBuildPath: ".workpilot" };
	state.gh = { token: "ghp-test-0000", repo: "acme/shop" };
	state.fetch.mockReset();
	state.runs = [];
	state.run = { exitCode: 0, stdout: "", error: "" };
	state.validation = { valid: true, backendPath: "/backend" };
	state.onRun = undefined;
	mainWindow = window;
	send.mockReset();
	startSpecCreation.mockReset();
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("the queue and the batches", () => {
	it("lists the auto-fix states newest first, skipping files it cannot read", async () => {
		const issues = path.join(githubDir(), "issues");
		writeJson(issues, "autofix_1.json", { issue_number: 1, status: "done", created_at: "2026-01-01T00:00:00Z" });
		writeJson(issues, "autofix_2.json", { issue_number: 2, status: "pending", created_at: "2026-02-01T00:00:00Z" });
		writeFileSync(path.join(issues, "autofix_3.json"), "{");
		writeJson(issues, "notes.json", { issue_number: 4 });

		const queue = (await invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_QUEUE)) as Array<{ issueNumber: number }>;

		expect(queue.map((q) => q.issueNumber)).toEqual([2, 1]);
	});

	it("has an empty queue and no batches before the first fix, and nothing for an unknown project", async () => {
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_QUEUE)).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_BATCHES)).resolves.toEqual([]);

		state.project = undefined;
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_QUEUE)).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_BATCHES)).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS)).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW)).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG, {
			enabled: true,
			labels: [],
			requireHumanApproval: true,
			model: "sonnet",
			thinkingLevel: "medium",
		})).resolves.toBe(false);
	});

	it("reads the batches the runner wrote, newest first", async () => {
		const batches = path.join(githubDir(), "batches");
		writeJson(batches, "batch_a.json", {
			batch_id: "a",
			primary_issue: 3,
			issues: [{ issue_number: 3, title: "Crash", similarity_to_primary: 1 }],
			status: "pending",
			created_at: "2026-01-01T00:00:00Z",
		});
		writeJson(batches, "batch_b.json", {
			batch_id: "b",
			primary_issue: 5,
			issues: [],
			common_themes: ["login"],
			created_at: "2026-03-01T00:00:00Z",
		});
		writeJson(batches, "batch_c.json", { batch_id: "c" });

		const read = (await invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_BATCHES)) as Array<Record<string, unknown>>;

		expect(read.map((b) => b.batchId)).toEqual(["b", "a"]);
		expect(read[1]).toMatchObject({
			primaryIssue: 3,
			issues: [{ issueNumber: 3, title: "Crash", similarityToPrimary: 1 }],
			commonThemes: [],
		});
	});
});

describe("GITHUB_AUTOFIX_CHECK_LABELS", () => {
	it("finds the open issues, not pull requests, that carry a fix label and are not queued yet", async () => {
		enable(["Auto-Fix"]);
		writeJson(path.join(githubDir(), "issues"), "autofix_3.json", { issue_number: 3 });
		state.fetch.mockResolvedValue([
			{ number: 1, labels: [{ name: "auto-fix" }] },
			{ number: 2, labels: [{ name: "auto-fix" }], pull_request: {} },
			{ number: 3, labels: [{ name: "auto-fix" }] },
			{ number: 4, labels: [{ name: "bug" }] },
		]);

		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS)).resolves.toEqual([1]);
		expect(state.fetch).toHaveBeenCalledWith("ghp-test-0000", "/repos/acme/shop/issues?state=open&per_page=100");
	});

	it("asks GitHub nothing while the auto-fix is off, has no label, or the project has no GitHub", async () => {
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS)).resolves.toEqual([]);
		enable([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS)).resolves.toEqual([]);
		enable();
		state.gh = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS)).resolves.toEqual([]);
		expect(state.fetch).not.toHaveBeenCalled();
	});
});

describe("GITHUB_AUTOFIX_CHECK_NEW", () => {
	it("asks the runner for the issues not in the queue yet", async () => {
		enable();
		state.run.stdout = 'progress\n[{"number": 8}]';

		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW)).resolves.toEqual([{ number: 8 }]);
		expect(state.runs[0].args).toEqual([path.join("/backend", "runners", "github", "runner.py"), "--project", projectDir, "check-new"]);
		expect(state.runs[0].env).toEqual({ RUNNER_ENV: "1" });
	});

	it("runs nothing while the auto-fix is off, and fails with the runner's reason", async () => {
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW)).resolves.toEqual([]);
		expect(state.runs).toHaveLength(0);

		enable();
		state.validation = { valid: false, error: "no runner" };
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW)).rejects.toThrow("no runner");

		state.validation = { valid: true, backendPath: "/backend" };
		state.run = { exitCode: 1, stdout: "", error: "" };
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW)).rejects.toThrow("Failed to check for new issues");
	});
});

describe("GITHUB_AUTOFIX_START", () => {
	const start = () => mock.emit(IPC_CHANNELS.GITHUB_AUTOFIX_START, {}, "p", 12);
	const issue = {
		number: 12,
		title: "Checkout crashes",
		body: "Steps: pay",
		labels: [{ name: "auto-fix" }],
		html_url: "https://github.com/acme/shop/issues/12",
	};

	it("writes a spec and the fix state from the issue, then starts the spec agent", async () => {
		state.fetch.mockImplementation(async (_token: string, endpoint: string) =>
			endpoint.endsWith("/comments") ? [{ id: 1, body: "Same here", user: { login: "ana" } }] : issue,
		);

		start();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_COMPLETE)).toHaveLength(1));

		const [specId, dir, task, specDir] = startSpecCreation.mock.calls[0] as string[];
		expect(dir).toBe(projectDir);
		expect(task).toContain("Checkout crashes");
		expect(task).toContain("Same here");
		expect(existsSync(specDir)).toBe(true);
		const saved = JSON.parse(readFileSync(path.join(githubDir(), "issues", "autofix_12.json"), "utf-8"));
		expect(saved).toMatchObject({
			issue_number: 12,
			repo: "acme/shop",
			status: "creating_spec",
			spec_id: specId,
			issue_url: issue.html_url,
		});
		expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_PROGRESS).at(-1)?.[0]).toMatchObject({
			phase: "complete",
			message: "Auto-fix spec creation started!",
		});
	});

	it("still completes, with the spec to start by hand, when the spec agent does not start", async () => {
		state.fetch.mockImplementation(async (_token: string, endpoint: string) =>
			endpoint.endsWith("/comments") ? [] : { ...issue, html_url: 12 },
		);
		startSpecCreation.mockImplementation(() => {
			throw new Error("busy");
		});

		start();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_COMPLETE)).toHaveLength(1));

		expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_PROGRESS).at(-1)?.[0]).toMatchObject({
			message: "Spec directory created. Click Start to begin.",
		});
		const saved = JSON.parse(readFileSync(path.join(githubDir(), "issues", "autofix_12.json"), "utf-8"));
		expect(saved.issue_url).toBe("");
	});

	it("reports a GitHub failure, and does nothing without a window or a project", async () => {
		state.fetch.mockRejectedValue(new Error("GitHub said 404"));
		start();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ERROR)).toEqual([[{ error: "GitHub said 404" }]]));

		send.mockReset();
		state.fetch.mockRejectedValue("not an error");
		start();
		await vi.waitFor(() =>
			expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ERROR)).toEqual([[{ error: "Failed to start auto-fix" }]]),
		);

		send.mockReset();
		state.fetch.mockReset();
		state.project = undefined;
		start();
		mainWindow = null;
		start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(send).not.toHaveBeenCalled();
		expect(state.fetch).not.toHaveBeenCalled();
	});
});

describe("GITHUB_AUTOFIX_BATCH", () => {
	const batch = (issueNumbers?: number[]) => mock.emit(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH, {}, "p", issueNumbers);

	it("runs the runner on the chosen issues and sends back the batches it wrote", async () => {
		state.onRun = (options) => {
			options.onProgress?.(50, "Grouping");
			writeJson(path.join(githubDir(), "batches"), "batch_x.json", {
				batch_id: "x",
				primary_issue: 1,
				issues: [{ issue_number: 1, title: "A" }],
				created_at: "2026-01-01T00:00:00Z",
			});
		};

		batch([1, 2]);
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_COMPLETE)).toHaveLength(1));

		expect(state.runs[0].args.slice(-3)).toEqual(["batch-issues", "1", "2"]);
		expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_COMPLETE)[0][0]).toMatchObject([{ batchId: "x" }]);
		const progress = sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_PROGRESS).map((p) => p[0]);
		expect(progress).toContainEqual(expect.objectContaining({ phase: "batching", progress: 50, totalIssues: 2 }));
		expect(progress.at(-1)).toMatchObject({ phase: "complete", message: "Created 1 batches", batchCount: 1 });
	});

	it("batches every issue when none is chosen, and reports the runner's failure", async () => {
		state.run = { exitCode: 1, stdout: "", error: "rate limited" };

		batch();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_ERROR)).toEqual([[{ error: "rate limited" }]]));
		expect(state.runs[0].args.at(-1)).toBe("batch-issues");

		send.mockReset();
		state.run = { exitCode: 1, stdout: "", error: "" };
		batch([]);
		await vi.waitFor(() =>
			expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_ERROR)).toEqual([[{ error: "Failed to batch issues" }]]),
		);

		send.mockReset();
		state.validation = { valid: false, error: "no runner" };
		batch();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_BATCH_ERROR)).toEqual([[{ error: "no runner" }]]));
	});

	it("does nothing without a window", async () => {
		mainWindow = null;
		batch([1]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(state.runs).toHaveLength(0);
	});
});

describe("GITHUB_AUTOFIX_ANALYZE_PREVIEW", () => {
	const preview = (issueNumbers?: number[], maxIssues?: number) =>
		mock.emit(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW, {}, "p", issueNumbers, maxIssues);
	const errors = () => sent(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW_ERROR);

	it("turns the runner's proposal into the renderer's shape", async () => {
		state.run.stdout = JSON.stringify({
			success: true,
			total_issues: 3,
			analyzed_issues: 3,
			proposed_batches: [
				{
					primary_issue: 1,
					issues: [{ issue_number: 1, title: "A" }, { issue_number: 2, title: "B", labels: ["x"], similarity_to_primary: 0.9 }],
					issue_count: 2,
					validated: true,
				},
			],
			single_issues: [{ issue_number: 3, title: "C" }],
		});
		state.onRun = (options) => options.onProgress?.(40, "Reading");

		preview([1, 2, 3], 20);
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE)).toHaveLength(1));

		expect(state.runs[0].args.slice(-7)).toEqual(["analyze-preview", "--json", "--max-issues", "20", "1", "2", "3"]);
		expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE)[0][0]).toEqual({
			success: true,
			totalIssues: 3,
			analyzedIssues: 3,
			alreadyBatched: 0,
			proposedBatches: [
				{
					primaryIssue: 1,
					issues: [
						{ issueNumber: 1, title: "A", labels: [], similarityToPrimary: 0 },
						{ issueNumber: 2, title: "B", labels: ["x"], similarityToPrimary: 0.9 },
					],
					issueCount: 2,
					commonThemes: [],
					validated: true,
					confidence: 0,
					reasoning: "",
					theme: "",
				},
			],
			singleIssues: [{ issueNumber: 3, title: "C", labels: [] }],
			message: "",
			error: undefined,
		});
		expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW_PROGRESS)).toContainEqual([
			{ phase: "analyzing", progress: 40, message: "Reading" },
		]);
	});

	it("analyzes every issue when none is chosen", async () => {
		state.run.stdout = '{"success": true}';
		preview();
		await vi.waitFor(() => expect(sent(IPC_CHANNELS.GITHUB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE)).toHaveLength(1));
		expect(state.runs[0].args.slice(-2)).toEqual(["analyze-preview", "--json"]);
	});

	it("says what went wrong in words the user can act on", async () => {
		state.run.stdout = "no result";
		preview();
		await vi.waitFor(() => expect(errors()).toHaveLength(1));
		expect(errors()[0][0]).toEqual({
			error: "No analysis results returned. Please check your GitHub connection and try again.",
		});

		send.mockReset();
		state.run.stdout = "{ not json }";
		preview();
		await vi.waitFor(() => expect(errors()).toHaveLength(1));
		expect(errors()[0][0].error).toMatch(/^Analysis completed, but there was an error processing the results/);

		send.mockReset();
		state.run = { exitCode: 1, stdout: "", error: "rate limited" };
		preview();
		await vi.waitFor(() => expect(errors()).toEqual([[{ error: "rate limited" }]]));

		send.mockReset();
		state.run = { exitCode: 1, stdout: "", error: "" };
		preview();
		await vi.waitFor(() => expect(errors()).toEqual([[{ error: "Failed to analyze issues" }]]));
	});

	it("does nothing without a window", async () => {
		mainWindow = null;
		preview();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(state.runs).toHaveLength(0);
	});
});

describe("GITHUB_AUTOFIX_APPROVE_BATCHES", () => {
	const approved = [
		{ primaryIssue: 4, issues: [{ issueNumber: 4, title: "Crash" }], theme: "crash" },
		{
			primaryIssue: 6,
			issues: [{ issueNumber: 6, title: "Login", labels: ["auth"], similarityToPrimary: 0.8 }],
			commonThemes: ["auth"],
			validated: false,
			confidence: 0.5,
			reasoning: "same page",
		},
	];

	it("hands the approved batches to the runner, in its environment, and removes the file after", async () => {
		let handed: unknown;
		state.onRun = (options) => {
			handed = JSON.parse(readFileSync(options.args.at(-1) as string, "utf-8"));
		};

		const result = await invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, approved);

		expect(result).toEqual({ success: true, batches: [] });
		expect(state.runs[0].args.slice(1, 4)).toEqual(["--project", projectDir, "approve-batches"]);
		expect(state.runs[0].env).toEqual({ RUNNER_ENV: "1" });
		expect(handed).toEqual([
			{
				primary_issue: 4,
				issues: [{ issue_number: 4, title: "Crash", labels: [], similarity_to_primary: 1 }],
				common_themes: [],
				validated: true,
				confidence: 1,
				reasoning: "User approved",
				theme: "crash",
			},
			{
				primary_issue: 6,
				issues: [{ issue_number: 6, title: "Login", labels: ["auth"], similarity_to_primary: 0.8 }],
				common_themes: ["auth"],
				validated: false,
				confidence: 0.5,
				reasoning: "same page",
				theme: "",
			},
		]);
		expect(readdirSync(githubDir())).toEqual([]);
	});

	it("reports the runner's failure and still removes the file", async () => {
		state.run = { exitCode: 1, stdout: "", error: "rate limited" };
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, approved)).resolves.toEqual({
			success: false,
			error: "rate limited",
		});
		expect(readdirSync(githubDir())).toEqual([]);

		state.run = { exitCode: 1, stdout: "", error: "" };
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, approved)).resolves.toEqual({
			success: false,
			error: "Failed to approve batches",
		});

		state.validation = { valid: false, error: "no runner" };
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, approved)).resolves.toEqual({
			success: false,
			error: "no runner",
		});
	});

	it("answers that the project is not found", async () => {
		state.project = undefined;
		await expect(invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, [])).resolves.toEqual({
			success: false,
			error: "Project not found",
		});
	});
});
