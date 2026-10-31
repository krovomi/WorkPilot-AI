/**
 * The review an automation starts (plan of 29 October, IA7) is the button's
 * review minus the side effects: nobody is assigned, nothing is posted, and
 * one PR is never reviewed twice at the same time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	finish: null as null | ((value: unknown) => void),
	fail: null as null | ((error: Error) => void),
	args: [] as string[][],
	valid: true,
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("../../../env-utils", () => ({ getAugmentedEnv: () => ({}) }));
vi.mock("../../../services/page-llm-config", () => ({
	getPageFeatureSettings: () => ({ model: "m", thinkingLevel: "low" }),
}));
vi.mock("../utils", () => ({
	getGitHubConfig: () => ({ token: "t", repo: "acme/app" }),
	githubFetch: vi.fn(),
}));
vi.mock("../utils/runner-env", () => ({ getRunnerEnv: async () => ({}) }));
vi.mock("../utils/project-middleware", () => ({ withProjectOrNull: vi.fn() }));
vi.mock("../pr-graphql", () => ({ fetchPRsFromGraphQL: vi.fn() }));
vi.mock("../pr-ci-wait", () => ({ performCIWaitCheck: vi.fn() }));
// A local project: nothing goes to a server.
vi.mock("../server-pr-review", () => ({
	serverProjectOf: () => undefined,
	serverReviews: vi.fn(),
	startServerReview: vi.fn(),
	cancelServerReview: () => false,
	postServerReview: vi.fn(),
	markServerReviewPosted: vi.fn(),
}));
vi.mock("../pr-logs", () => ({
	sanitizeNetworkData: (data: string) => data,
	getGitHubDir: () => "/nowhere",
	loadPRLogs: vi.fn(),
	PRLogCollector: class {
		processLine = vi.fn();
		finalize = vi.fn();
	},
}));
vi.mock("../utils/subprocess-runner", () => ({
	validateGitHubModule: async () =>
		state.valid ? { valid: true, backendPath: "/backend" } : { valid: false, error: "gh is not installed" },
	getRunnerPath: () => "runner.py",
	getPythonPath: () => "python",
	buildRunnerArgs: (runner: string, project: string, command: string, extra: string[]) => [
		runner,
		project,
		command,
		...extra,
	],
	runPythonSubprocess: (options: { args: string[] }) => {
		state.args.push(options.args);
		return {
			process: { pid: 1, kill: vi.fn() },
			promise: new Promise((resolve, reject) => {
				state.finish = resolve;
				state.fail = reject;
			}),
		};
	},
}));

import { githubFetch } from "../utils";
import { hasPRReview, startDraftPRReview } from "../pr-handlers";

const project = { id: "p1", name: "app", path: "/p" } as unknown as Project;
const sent: unknown[][] = [];
const window = { webContents: { send: (...args: unknown[]) => sent.push(args) } } as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	sent.length = 0;
	state.args = [];
	state.valid = true;
	state.finish = null;
	state.fail = null;
});
afterEach(async () => {
	// Let any review still held release its slot.
	state.finish?.({ success: true, data: { prNumber: 0, findings: [] } });
	await settle();
});

describe("startDraftPRReview", () => {
	it("runs review-pr without --auto-post, assigns nobody, and announces the result", async () => {
		await startDraftPRReview(project, 12, window);
		await settle();
		expect(state.args).toEqual([["runner.py", "/p", "review-pr", "12"]]);
		expect(state.args[0]).not.toContain("--auto-post");
		expect(githubFetch).not.toHaveBeenCalled();
		expect(hasPRReview(project, 12)).toBe(true);

		const result = { prNumber: 12, findings: [], summary: "ok" };
		state.finish?.({ success: true, data: result });
		await settle();
		expect(sent).toEqual([[IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE, "p1", result]]);
		expect(hasPRReview(project, 12)).toBe(false);
	});

	it("refuses a second review of the same PR while one runs", async () => {
		await startDraftPRReview(project, 13, window);
		await expect(startDraftPRReview(project, 13, window)).rejects.toThrow(/already running/);
		expect(state.args).toHaveLength(1);
	});

	it("fails before launching when the GitHub module is not ready, and frees the PR", async () => {
		state.valid = false;
		await expect(startDraftPRReview(project, 14, window)).rejects.toThrow(/gh is not installed/);
		expect(state.args).toEqual([]);
		expect(hasPRReview(project, 14)).toBe(false);
	});

	it("reports a review that failed while running to the view, with its PR", async () => {
		await startDraftPRReview(project, 15, window);
		await settle();
		state.fail?.(new Error("model refused"));
		state.finish = null;
		await settle();
		expect(sent).toEqual([
			[IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR, "p1", { prNumber: 15, error: "model refused" }],
		]);
		expect(hasPRReview(project, 15)).toBe(false);
	});

	it("refuses what is not a PR number", async () => {
		await expect(startDraftPRReview(project, 0, window)).rejects.toThrow(/number/);
		await expect(startDraftPRReview(project, 1.5, window)).rejects.toThrow(/number/);
	});
});
