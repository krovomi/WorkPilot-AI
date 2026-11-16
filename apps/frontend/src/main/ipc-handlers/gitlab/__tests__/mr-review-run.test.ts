/**
 * @vitest-environment node
 *
 * The local run of a merge request review: one run per MR at a time, the
 * first review assigns the person, both run the app's GitLab runner with the
 * project's token, the view hears progress, result and failure with the MR's
 * iid, and cancelling stops the runner's tree, then kills it if it stays.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RunOptions {
	pythonPath: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	onProgress: (percent: number, message: string) => void;
	onStdout: (line: string) => void;
	onStderr: (line: string) => void;
	onAuthFailure: (info: unknown) => void;
	onComplete: () => unknown;
}

interface FakeRun {
	options: RunOptions;
	child: { pid: number; exitCode: number | null; signalCode: string | null };
	finish: (value: { success: boolean; data?: unknown; error?: string }) => void;
}

const state = vi.hoisted(() => ({
	backend: "/app/backend" as string | null,
	config: null as null | { token: string; instanceUrl: string; project: string },
	fetches: [] as { endpoint: string; options?: RequestInit }[],
	userFails: false,
	runs: [] as FakeRun[],
	kills: [] as { pid: number; signal: string }[],
	envOverrides: [] as Record<string, string>[],
	model: "sonnet",
}));

vi.mock("../../github/utils/subprocess-runner", () => ({
	findAppBackendPath: () => state.backend,
	getPythonPath: (backend: string) => `${backend}/.venv/bin/python`,
	buildRunnerArgs: (runner: string, project: string, command: string, args: string[]) => [
		runner,
		"--project",
		project,
		command,
		...args,
	],
	killProcessTree: (child: { pid: number }, signal: string) =>
		state.kills.push({ pid: child.pid, signal }),
	runPythonSubprocess: (options: RunOptions) => {
		let finish!: FakeRun["finish"];
		const promise = new Promise<{ success: boolean; data?: unknown; error?: string }>(
			(resolve) => {
				finish = resolve;
			},
		);
		const child = { pid: 100 + state.runs.length, exitCode: null, signalCode: null };
		state.runs.push({ options, child, finish });
		return { process: child, promise };
	},
}));
vi.mock("../../github/utils/runner-env", () => ({
	getRunnerEnv: async (overrides: Record<string, string>) => {
		state.envOverrides.push(overrides);
		return { ...overrides, RUNNER: "1" };
	},
}));
vi.mock("../../../services/page-llm-config", () => ({
	getPageFeatureSettings: () => ({ model: state.model, thinkingLevel: "high" }),
}));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitLabConfig: async () => state.config,
	gitlabFetch: async (_token: string, _instance: string, endpoint: string, options?: RequestInit) => {
		state.fetches.push({ endpoint, options });
		if (endpoint === "/user") {
			if (state.userFails) throw "offline";
			return { id: 9 };
		}
		return {};
	},
}));

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS, MODEL_ID_MAP } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";
import {
	cancelLocalReview,
	getGitLabMRSettings,
	getReviewPath,
	getReviewResult,
	runButtonReview,
	updateSavedReview,
} from "../mr-review-run";

let dir: string;
let project: Project;
const send = vi.fn();
const window = { webContents: { send } } as unknown as BrowserWindow;
const sent = (channel: string) =>
	send.mock.calls.filter(([c]) => c === channel).map(([, , payload]) => payload);

function saveReview(mrIid: number, data: Record<string, unknown> = {}) {
	const file = getReviewPath(project, mrIid);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			mr_iid: mrIid,
			project: "acme/shop",
			success: true,
			findings: [],
			summary: "ok",
			overall_status: "approve",
			reviewed_at: "2026-11-16T00:00:00Z",
			...data,
		}),
	);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "mr-review-run-"));
	project = { id: "p1", path: dir } as unknown as Project;
	state.backend = "/app/backend";
	state.config = { token: "pat-test-0000", instanceUrl: "https://gitlab.acme.dev", project: "acme/shop" };
	state.fetches = [];
	state.userFails = false;
	state.runs = [];
	state.kills = [];
	state.envOverrides = [];
	send.mockReset();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

describe("the review the button starts", () => {
	it("assigns the person, runs the runner with the project's token, and sends the result", async () => {
		const pending = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));

		expect(state.fetches).toEqual([
			{ endpoint: "/user", options: undefined },
			{
				endpoint: "/projects/acme%2Fshop/merge_requests/7",
				options: { method: "PUT", body: JSON.stringify({ assignee_ids: [9] }) },
			},
		]);
		const { options } = state.runs[0];
		expect(options.pythonPath).toBe("/app/backend/.venv/bin/python");
		expect(options.cwd).toBe("/app/backend");
		expect(options.args).toEqual([
			path.join("/app/backend", "runners", "gitlab", "runner.py"),
			"--project",
			dir,
			"review-mr",
			"7",
		]);
		expect(state.envOverrides[0]).toEqual({
			GITLAB_TOKEN: "pat-test-0000",
			GITLAB_INSTANCE_URL: "https://gitlab.acme.dev",
		});

		options.onProgress(40, "Analyzing");
		options.onStdout("reading");
		options.onStderr("warning");
		options.onAuthFailure({ profileId: "work" });
		saveReview(7);
		const result = options.onComplete();
		state.runs[0].finish({ success: true, data: result });
		await pending;

		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS)).toEqual([
			{ phase: "fetching", mrIid: 7, progress: 5, message: "Assigning you to MR..." },
			{ phase: "fetching", mrIid: 7, progress: 10, message: "Fetching MR data..." },
			{ phase: "analyzing", mrIid: 7, progress: 40, message: "Analyzing" },
			{ phase: "complete", mrIid: 7, progress: 100, message: "Review complete!" },
		]);
		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_COMPLETE)).toEqual([result]);
		expect(send).toHaveBeenCalledWith(IPC_CHANNELS.CLAUDE_AUTH_FAILURE, { profileId: "work" });
	});

	it("runs the follow-up without assigning anyone", async () => {
		const pending = runButtonReview(project, 7, window, "followup");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		expect(state.fetches).toEqual([]);
		expect(state.runs[0].options.args.slice(-2)).toEqual(["followup-review-mr", "7"]);

		state.runs[0].finish({ success: false });
		await pending;
		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_PROGRESS)[0]).toMatchObject({
			message: "Starting follow-up review...",
		});
		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)).toEqual([
			{ mrIid: 7, error: "Follow-up review failed for MR #7: Follow-up review failed" },
		]);
	});

	it("goes on when the assignment fails, and without a GitLab config", async () => {
		state.userFails = true;
		let pending = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		state.runs[0].finish({ success: false, error: "boom" });
		await pending;

		state.config = null;
		pending = runButtonReview(project, 8, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(2));
		expect(state.envOverrides[1]).toEqual({});
		state.runs[1].finish({ success: false, error: "boom" });
		await pending;

		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)).toEqual([
			{ mrIid: 7, error: "MR review failed for MR #7: boom" },
			{ mrIid: 8, error: "MR review failed for MR #8: boom" },
		]);
	});

	it("says the runner is missing, and that the result is, with the MR's iid", async () => {
		state.backend = null;
		await runButtonReview(project, 7, window, "review");
		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR)[0]).toEqual({
			mrIid: 7,
			error:
				"MR review failed for MR #7: GitLab runners not found. Please ensure the backend is properly installed.",
		});

		state.backend = "/app/backend";
		const pending = runButtonReview(project, 7, window, "followup");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		expect(() => state.runs[0].options.onComplete()).toThrow(
			"Follow-up review completed but result not found",
		);
		state.runs[0].finish({ success: true });
		await pending;
	});

	it("reports what is not an Error as text", async () => {
		const pending = runButtonReview(project, 7, window, "followup");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		state.runs[0].finish(Promise.reject("runner vanished") as never);
		await pending;
		expect(sent(IPC_CHANNELS.GITLAB_MR_REVIEW_ERROR).at(-1)).toEqual({
			mrIid: 7,
			error: "Follow-up review failed for MR #7: runner vanished",
		});
	});

	it("leaves an MR already under review to that review", async () => {
		const first = runButtonReview(project, 7, window, "review");
		await runButtonReview(project, 7, window, "followup");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		await runButtonReview(project, 7, window, "review");
		expect(state.runs).toHaveLength(1);

		state.runs[0].finish({ success: false });
		await first;
		const again = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(2));
		state.runs[1].finish({ success: false });
		await again;
	});
});

describe("cancelling", () => {
	it("stops the runner's tree, then kills it after a second if it is still there", async () => {
		vi.useFakeTimers();
		const pending = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		const { child } = state.runs[0];

		expect(cancelLocalReview("p1", 7)).toBe(true);
		expect(state.kills).toEqual([{ pid: child.pid, signal: "SIGTERM" }]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(state.kills).toEqual([
			{ pid: child.pid, signal: "SIGTERM" },
			{ pid: child.pid, signal: "SIGKILL" },
		]);
		expect(cancelLocalReview("p1", 7)).toBe(false);

		state.runs[0].finish({ success: false, error: "killed" });
		await pending;
	});

	it("does not kill a runner that exited during the grace", async () => {
		vi.useFakeTimers();
		const pending = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		cancelLocalReview("p1", 7);
		state.runs[0].child.exitCode = 143;
		await vi.advanceTimersByTimeAsync(1000);
		expect(state.kills).toHaveLength(1);
		state.runs[0].finish({ success: false });
		await pending;
	});

	it("before the runner starts, keeps it from starting", async () => {
		const pending = runButtonReview(project, 7, window, "review");
		expect(cancelLocalReview("p1", 7)).toBe(true);
		await pending;
		expect(state.runs).toEqual([]);
		expect(state.kills).toEqual([]);
	});

	it("lets a review started after a cancelled one keep its slot", async () => {
		const first = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(1));
		cancelLocalReview("p1", 7);
		const second = runButtonReview(project, 7, window, "review");
		await vi.waitFor(() => expect(state.runs).toHaveLength(2));

		state.runs[0].finish({ success: false, error: "killed" });
		await first;
		await flush();
		expect(cancelLocalReview("p1", 7)).toBe(true);
		state.runs[1].finish({ success: false });
		await second;
	});

	it("is false when nothing runs", () => {
		expect(cancelLocalReview("p1", 99)).toBe(false);
	});
});

describe("the saved review", () => {
	it("is read from the project, null when missing or unreadable", () => {
		expect(getReviewResult(project, 7)).toBeNull();
		saveReview(7, { summary: "Looks fine" });
		expect(getReviewResult(project, 7)).toMatchObject({ mrIid: 7, summary: "Looks fine" });
		writeFileSync(getReviewPath(project, 7), "{");
		expect(getReviewResult(project, 7)).toBeNull();
	});

	it("is changed in place, and left alone when it cannot be read", () => {
		saveReview(7);
		expect(updateSavedReview(project, 7, (data) => (data.has_posted_findings = true))).toBe(true);
		expect(JSON.parse(readFileSync(getReviewPath(project, 7), "utf-8"))).toMatchObject({
			has_posted_findings: true,
		});
		expect(updateSavedReview(project, 8, () => undefined)).toBe(false);
	});
});

it("keeps a model it has no full id for as it is", () => {
	state.model = "local-model-x";
	expect(getGitLabMRSettings().model).toBe("local-model-x");
	state.model = "sonnet";
});

it("takes the page's model by its full id", () => {
	expect(getGitLabMRSettings()).toEqual({
		model: MODEL_ID_MAP.sonnet ?? "sonnet",
		thinkingLevel: "high",
	});
});
