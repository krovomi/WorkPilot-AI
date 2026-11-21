/**
 * @vitest-environment node
 *
 * The local run of a PR review, against a stand-in runner, CI wait and
 * GitHub: the review the button starts (assignment, CI wait, then the run),
 * the follow-up, the automation's draft review, and cancelling. One PR is
 * reviewed once at a time, every exit frees it, a failure reaches the view
 * with its PR number, and cancelling stops the runner's whole tree.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

/** What the review run passes to the Python runner, as these tests read it. */
interface RunOptions {
	args: string[];
	pythonPath: string;
	cwd: string;
	env: Record<string, string>;
	operationRegistration: { metadata: { repo: string } } & Record<string, unknown>;
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
	validation: { valid: true, backendPath: "/backend" } as { valid: boolean; backendPath?: string; error?: string },
	validationGate: null as Promise<void> | null,
	runs: [] as FakeRun[],
	ciProceed: true as boolean | Promise<boolean>,
	ciCalls: [] as { operation: string; signal: AbortSignal }[],
	config: { token: "pat-test-0000", repo: "acme/shop" } as { token: string; repo: string } | null,
	fetches: [] as { endpoint: string; options?: RequestInit }[],
	assignFails: false,
	kills: [] as [number, string][],
	collectors: [] as { lines: string[]; finalized: boolean | null; followup: boolean }[],
	model: "sonnet",
}));

vi.mock("../utils/subprocess-runner", () => ({
	validateGitHubModule: async () => {
		await state.validationGate;
		return state.validation;
	},
	getRunnerPath: (backend: string) => `${backend}/runner.py`,
	getPythonPath: (backend: string) => `${backend}/python`,
	buildRunnerArgs: (runner: string, project: string, command: string, extra: string[], opts: object) => [
		runner,
		project,
		command,
		...extra,
		JSON.stringify(opts),
	],
	runPythonSubprocess: (options: RunOptions) => {
		let finish!: FakeRun["finish"];
		const promise = new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
			finish = resolve;
		});
		const child = { pid: 100 + state.runs.length, exitCode: null, signalCode: null };
		state.runs.push({ options, child, finish });
		return { process: child, promise };
	},
	killProcessTree: (child: { pid: number }, signal: string) => state.kills.push([child.pid, signal]),
}));
vi.mock("../utils/runner-env", () => ({
	getRunnerEnv: async (extra: Record<string, string>, options: object) => ({ ...extra, OPTIONS: JSON.stringify(options) }),
}));
vi.mock("../../../services/page-llm-config", () => ({
	getPageFeatureSettings: () => ({ model: state.model, thinkingLevel: "high" }),
}));
vi.mock("../pr-ci-wait", () => ({
	performCIWaitCheck: async (_config: unknown, _pr: number, _send: unknown, operation: string, signal: AbortSignal) => {
		state.ciCalls.push({ operation, signal });
		return state.ciProceed;
	},
}));
vi.mock("../utils", () => ({
	getGitHubConfig: () => state.config,
	githubFetch: async (_token: string, endpoint: string, options?: RequestInit) => {
		state.fetches.push({ endpoint, options });
		if (state.assignFails) throw new Error("HTTP 403");
		return endpoint === "/user" ? { login: "octocat" } : {};
	},
}));
vi.mock("../pr-logs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pr-logs")>()),
	PRLogCollector: class {
		record: { lines: string[]; finalized: boolean | null; followup: boolean };
		constructor(_project: unknown, _pr: number, _repo: string, followup: boolean) {
			this.record = { lines: [], finalized: null, followup };
			state.collectors.push(this.record);
		}
		processLine(line: string) {
			this.record.lines.push(line);
		}
		finalize(success: boolean) {
			this.record.finalized = success;
		}
	},
}));

import {
	cancelLocalReview,
	getGitHubPRSettings,
	getReviewPath,
	getReviewResult,
	hasPRReview,
	runButtonReview,
	startDraftPRReview,
	updateSavedReview,
} from "../pr-review-run";

let root: string;
let project: Project;
const sent: unknown[][] = [];
const window = {
	webContents: { send: (...args: unknown[]) => sent.push(args) },
} as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean) => {
	for (let i = 0; i < 50 && !check(); i++) await settle();
	expect(check()).toBe(true);
};

const saveReview = (prNumber: number, fields: Record<string, unknown> = {}) => {
	mkdirSync(path.dirname(getReviewPath(project, prNumber)), { recursive: true });
	writeFileSync(
		getReviewPath(project, prNumber),
		JSON.stringify({ pr_number: prNumber, repo: "acme/shop", success: true, findings: [], summary: "ok", ...fields }),
	);
};
const events = (channel: string) => sent.filter(([c]) => c === channel).map(([, , payload]) => payload);
const messages = () => events(IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS).map((p) => (p as { message: string }).message);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "pr-review-run-"));
	project = { id: "p1", name: "shop", path: root, settings: {} } as unknown as Project;
	sent.length = 0;
	Object.assign(state, {
		validation: { valid: true, backendPath: "/backend" },
		validationGate: null,
		runs: [],
		ciProceed: true,
		ciCalls: [],
		config: { token: "pat-test-0000", repo: "acme/shop" },
		fetches: [],
		assignFails: false,
		kills: [],
		collectors: [],
		model: "sonnet",
	});
});

afterEach(async () => {
	// Let any review still held free its slot.
	for (const run of state.runs) run.finish({ success: false, error: "test over" });
	await settle();
	await settle();
	rmSync(root, { recursive: true, force: true });
});

describe("the saved review", () => {
	it("is read from the project's GitHub folder, null when missing or broken", () => {
		expect(getReviewResult(project, 7)).toBeNull();
		expect(hasPRReview(project, 7)).toBe(false);

		saveReview(7, { reviewed_commit_sha: "abc" });
		expect(getReviewResult(project, 7)).toMatchObject({ prNumber: 7, reviewedCommitSha: "abc" });
		expect(hasPRReview(project, 7)).toBe(true);

		writeFileSync(getReviewPath(project, 7), "{ broken");
		expect(getReviewResult(project, 7)).toBeNull();
	});

	it("is changed in place, and not when there is none", () => {
		expect(updateSavedReview(project, 7, (data) => (data.review_id = 1))).toBe(false);

		saveReview(7, { review_id: 3 });
		expect(updateSavedReview(project, 7, (data) => delete data.review_id)).toBe(true);
		expect(JSON.parse(readFileSync(getReviewPath(project, 7), "utf-8"))).not.toHaveProperty("review_id");
	});

	it("survives an update that throws something that is not an error", () => {
		saveReview(7);
		expect(
			updateSavedReview(project, 7, () => {
				throw "no";
			}),
		).toBe(false);
	});
});

describe("getGitHubPRSettings", () => {
	it("turns the page's model name into its id, and keeps a full id as it is", () => {
		expect(getGitHubPRSettings()).toEqual({ model: "claude-sonnet-5-5", thinkingLevel: "high" });
		state.model = "gpt-5.5";
		expect(getGitHubPRSettings()).toEqual({ model: "gpt-5.5", thinkingLevel: "high" });
	});
});

describe("runButtonReview (first review)", () => {
	it("assigns the person, waits for CI, runs review-pr and announces the saved review", async () => {
		project = { ...project, settings: { useClaudeMd: false, tddMode: true } } as unknown as Project;
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);
		const { options } = state.runs[0];

		expect(state.fetches.map((f) => f.endpoint)).toEqual(["/user", "/repos/acme/shop/issues/7/assignees"]);
		expect(state.fetches[1].options).toMatchObject({ method: "POST", body: JSON.stringify({ assignees: ["octocat"] }) });
		expect(state.ciCalls.map((c) => c.operation)).toEqual(["review"]);
		expect(options.args).toEqual([
			"/backend/runner.py",
			root,
			"review-pr",
			"7",
			JSON.stringify({ model: "claude-sonnet-5-5", thinkingLevel: "high", repo: "acme/shop" }),
		]);
		expect(options.pythonPath).toBe("/backend/python");
		expect(options.cwd).toBe("/backend");
		expect(options.env).toMatchObject({ USE_CLAUDE_MD: "false", TDD_MODE: "true" });
		expect(JSON.parse(options.env.OPTIONS)).toEqual({ jevWorkflow: "github-review", page: "github-prs" });
		expect(options.operationRegistration).toEqual({
			operationId: "pr-review:p1:7",
			operationType: "pr-review",
			metadata: { projectId: "p1", prNumber: 7, repo: "acme/shop" },
		});
		expect(hasPRReview(project, 7)).toBe(true);

		options.onProgress(40, "Analyzing");
		options.onStdout("[context] reading");
		options.onStderr("warning");
		options.onAuthFailure({ profileId: "work" });
		saveReview(7, { summary: "Looks good" });
		const result = options.onComplete();
		state.runs[0].finish({ success: true, data: result });
		await done;

		expect(messages()).toEqual([
			"Assigning you to PR...",
			"Fetching PR data...",
			"Analyzing",
			"Review complete!",
		]);
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE)).toEqual([result]);
		expect(sent).toContainEqual([IPC_CHANNELS.CLAUDE_AUTH_FAILURE, { profileId: "work" }]);
		expect(state.collectors).toEqual([{ lines: ["[context] reading"], finalized: true, followup: false }]);
		// Freed: only the saved review remains.
		rmSync(getReviewPath(project, 7));
		expect(hasPRReview(project, 7)).toBe(false);
	});

	it("reviews when the assignment fails, and sends CLAUDE.md on by default", async () => {
		state.assignFails = true;
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);

		expect(state.runs[0].options.env).toMatchObject({ USE_CLAUDE_MD: "true" });
		expect(state.runs[0].options.env).not.toHaveProperty("TDD_MODE");
		state.runs[0].finish({ success: true, data: { prNumber: 7 } });
		await done;
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE)).toEqual([{ prNumber: 7 }]);
	});

	it("neither assigns nor waits for CI without a GitHub configuration, and names the project as the repo", async () => {
		state.config = null;
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);

		expect(state.fetches).toEqual([]);
		expect(state.ciCalls).toEqual([]);
		expect(state.runs[0].options.operationRegistration.metadata.repo).toBe("shop");
		state.runs[0].finish({ success: true, data: { prNumber: 7 } });
		await done;
	});

	it("names an unknown repo for a project without a name", async () => {
		state.config = null;
		project = { ...project, name: "" } as Project;
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);

		expect(state.runs[0].options.operationRegistration.metadata.repo).toBe("unknown");
		state.runs[0].finish({ success: true, data: { prNumber: 7 } });
		await done;
	});

	it("stops quietly when the CI wait says not to proceed, and frees the PR", async () => {
		state.ciProceed = false;

		await runButtonReview(project, 7, window, "review");

		expect(state.runs).toEqual([]);
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([]);
		expect(hasPRReview(project, 7)).toBe(false);
	});

	it("leaves a PR already under review to that review", async () => {
		const first = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);
		sent.length = 0;

		await runButtonReview(project, 7, window, "followup");

		expect(sent).toEqual([]);
		expect(state.runs).toHaveLength(1);
		state.runs[0].finish({ success: true, data: { prNumber: 7 } });
		await first;
	});

	it.each([
		[{ success: false, error: "Rate limited" }, "Rate limited"],
		[{ success: false }, "Review failed"],
		[{ success: true }, "Review failed"],
	])("sends the failure %j with its PR number", async (outcome, error) => {
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);
		state.runs[0].finish(outcome);
		await done;

		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([{ prNumber: 7, error }]);
		expect(state.collectors[0].finalized).toBe(outcome.success);
		expect(hasPRReview(project, 7)).toBe(false);
	});

	it("fails when the review ends without a saved result", async () => {
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.runs.length === 1);

		expect(() => state.runs[0].options.onComplete()).toThrow("Review completed but result not found");
		state.runs[0].finish({ success: false, error: "Review completed but result not found" });
		await done;
	});

	it.each([
		[{ valid: false, error: "gh is not installed" }, "gh is not installed"],
		[{ valid: false }, "GitHub module validation failed"],
		[{ valid: true }, "GitHub module validation failed"],
	])("sends the module check %j as the failure of the PR", async (validation, error) => {
		state.validation = validation;

		await runButtonReview(project, 7, window, "review");

		expect(state.runs).toEqual([]);
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([{ prNumber: 7, error }]);
		expect(hasPRReview(project, 7)).toBe(false);
	});

	it("names the failure when something that is not an error is thrown", async () => {
		state.ciProceed = Promise.reject("CI down");

		await runButtonReview(project, 7, window, "followup");

		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([
			{ prNumber: 7, error: "Failed to run PR follow-up review" },
		]);
	});
});

describe("runButtonReview (follow-up)", () => {
	it("runs followup-review-pr without assigning anyone", async () => {
		const done = runButtonReview(project, 8, window, "followup");
		await until(() => state.runs.length === 1);
		const { options } = state.runs[0];

		expect(state.fetches).toEqual([]);
		expect(state.ciCalls.map((c) => c.operation)).toEqual(["follow-up review"]);
		expect(options.args[2]).toBe("followup-review-pr");
		expect(options.operationRegistration).toEqual({
			operationId: "pr-followup-review:p1:8",
			operationType: "pr-review",
			metadata: { projectId: "p1", prNumber: 8, repo: "acme/shop", isFollowup: true },
		});
		expect(() => options.onComplete()).toThrow("Follow-up review completed but result not found");

		state.runs[0].finish({ success: true, data: { prNumber: 8 } });
		await done;
		expect(messages()).toEqual(["Starting follow-up review...", "Follow-up review complete!"]);
		expect(state.collectors[0].followup).toBe(true);
	});

	it("names the follow-up in a failure without a message", async () => {
		const done = runButtonReview(project, 8, window, "followup");
		await until(() => state.runs.length === 1);
		state.runs[0].finish({ success: false });
		await done;

		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([{ prNumber: 8, error: "Follow-up review failed" }]);
	});
});

describe("cancelLocalReview", () => {
	it("answers false when no review of the PR runs here", () => {
		expect(cancelLocalReview("p1", 7)).toBe(false);
	});

	it("aborts the CI wait and frees the PR", async () => {
		let release!: (proceed: boolean) => void;
		state.ciProceed = new Promise((resolve) => {
			release = resolve;
		});
		const done = runButtonReview(project, 7, window, "review");
		await until(() => state.ciCalls.length === 1);

		expect(cancelLocalReview("p1", 7)).toBe(true);
		expect(state.ciCalls[0].signal.aborted).toBe(true);
		expect(hasPRReview(project, 7)).toBe(false);

		release(false);
		await done;
		expect(state.runs).toEqual([]);
	});

	it("stops the runner's tree, then kills it if it is still there after the grace", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const first = runButtonReview(project, 7, window, "review");
			await vi.waitFor(() => expect(state.runs).toHaveLength(1));
			const { child } = state.runs[0];

			expect(cancelLocalReview("p1", 7)).toBe(true);
			expect(state.kills).toEqual([[child.pid, "SIGTERM"]]);
			vi.advanceTimersByTime(1000);
			expect(state.kills).toEqual([
				[child.pid, "SIGTERM"],
				[child.pid, "SIGKILL"],
			]);

			// A new review of the PR starts before the old runner reports.
			const second = runButtonReview(project, 7, window, "review");
			await vi.waitFor(() => expect(state.runs).toHaveLength(2));
			state.runs[0].finish({ success: false, error: "terminated" });
			await first;
			expect(hasPRReview(project, 7)).toBe(true);

			// The second runner exits on SIGTERM: no SIGKILL follows.
			expect(cancelLocalReview("p1", 7)).toBe(true);
			state.runs[1].child.exitCode = 143;
			vi.advanceTimersByTime(1000);
			expect(state.kills.filter(([pid]) => pid === state.runs[1].child.pid)).toEqual([
				[state.runs[1].child.pid, "SIGTERM"],
			]);
			state.runs[1].finish({ success: false, error: "terminated" });
			await second;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("startDraftPRReview", () => {
	it("refuses what is not a PR number", async () => {
		for (const bad of [0, -1, 1.5]) {
			await expect(startDraftPRReview(project, bad, window)).rejects.toThrow("Not a pull request number");
		}
	});

	it("runs review-pr without assigning anyone nor waiting for CI, and announces the result", async () => {
		await startDraftPRReview(project, 9, window);
		await until(() => state.runs.length === 1);

		expect(state.fetches).toEqual([]);
		expect(state.ciCalls).toEqual([]);
		expect(state.runs[0].options.args[2]).toBe("review-pr");
		await expect(startDraftPRReview(project, 9, window)).rejects.toThrow("already running");

		state.runs[0].finish({ success: true, data: { prNumber: 9 } });
		await until(() => events(IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE).length === 1);
		await settle();
		expect(hasPRReview(project, 9)).toBe(false);
	});

	it("sends a failure with its PR number", async () => {
		await startDraftPRReview(project, 9, window);
		await until(() => state.runs.length === 1);
		state.runs[0].finish({ success: false, error: "boom" });

		await until(() => events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR).length === 1);
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([{ prNumber: 9, error: "boom" }]);
	});

	it("names a failure that is not an error", async () => {
		await startDraftPRReview(project, 9, window);
		await until(() => state.runs.length === 1);
		// The run settles with something that is not an error.
		state.runs[0].finish(Promise.reject("down") as never);

		await until(() => events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR).length === 1);
		expect(events(IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR)).toEqual([{ prNumber: 9, error: "Failed to run PR review" }]);
	});

	it("frees the PR when the module is not ready, or the review was cancelled meanwhile", async () => {
		state.validation = { valid: false, error: "gh is not installed" };
		await expect(startDraftPRReview(project, 9, window)).rejects.toThrow("gh is not installed");
		expect(hasPRReview(project, 9)).toBe(false);

		state.validation = { valid: true, backendPath: "/backend" };
		let open!: () => void;
		state.validationGate = new Promise((resolve) => {
			open = resolve;
		});
		const pending = startDraftPRReview(project, 9, window);
		expect(cancelLocalReview("p1", 9)).toBe(true);
		open();
		await expect(pending).rejects.toThrow("The review was cancelled");
		expect(state.runs).toEqual([]);
		expect(hasPRReview(project, 9)).toBe(false);
	});

	it("keeps the result on disk when the window is gone", async () => {
		const closed = {
			webContents: {
				send: () => {
					throw new Error("Object has been destroyed");
				},
			},
		} as never;
		await startDraftPRReview(project, 9, closed);
		await until(() => state.runs.length === 1);
		state.runs[0].finish({ success: true, data: { prNumber: 9 } });
		await settle();
		await settle();
		expect(hasPRReview(project, 9)).toBe(false);
	});
});
