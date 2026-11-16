/**
 * @vitest-environment node
 *
 * The pull request handlers, against a stand-in GitHub API, `gh` actions and
 * server. Each handler answers its empty value without a project or a GitHub
 * configuration, reads and changes the saved review on disk, and sends a
 * server project's call to the server.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	project: null as unknown,
	config: { token: "pat-test-0000", repo: "acme/shop" } as { token: string; repo: string } | null,
	routes: new Map<string, unknown>(),
	fetches: [] as { endpoint: string; options?: RequestInit }[],
	remote: undefined as unknown,
	actions: {
		prDiff: vi.fn(),
		prComment: vi.fn(),
		prMerge: vi.fn(),
		prUpdateBranch: vi.fn(),
	},
	graphql: vi.fn(),
	loadPRLogs: vi.fn(),
	post: vi.fn(),
	server: {
		serverReviews: vi.fn(),
		markServerReviewPosted: vi.fn(),
		postServerReview: vi.fn(),
		startServerReview: vi.fn(),
		cancelServerReview: vi.fn(() => false),
	},
	runButtonReview: vi.fn(async () => undefined),
	cancelLocalReview: vi.fn(() => false),
}));

vi.mock("../utils", () => ({
	getGitHubConfig: () => state.config,
	githubFetch: async (_token: string, endpoint: string, options?: RequestInit) => {
		state.fetches.push({ endpoint, options });
		const answer = state.routes.get(endpoint);
		if (answer === "throw-text") throw "down";
		if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`404 ${endpoint}`);
		return answer;
	},
}));
vi.mock("../utils/project-middleware", () => ({
	withProjectOrNull: async (id: string, handler: (p: unknown) => unknown) =>
		id === "p1" && state.project ? handler(state.project) : null,
	withForgeProjectOrNull: async (id: string, handler: (p: unknown) => unknown) =>
		id === "p1" && state.project ? handler(state.project) : null,
}));
vi.mock("../pr-actions", () => state.actions);
vi.mock("../pr-graphql", () => ({ fetchPRsFromGraphQL: state.graphql }));
vi.mock("../pr-logs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pr-logs")>()),
	loadPRLogs: state.loadPRLogs,
}));
vi.mock("../pr-review-post", () => ({ postReviewToGitHub: state.post }));
vi.mock("../server-pr-review", () => ({
	...state.server,
	serverProjectOf: () => state.remote,
}));
vi.mock("../pr-review-run", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pr-review-run")>()),
	runButtonReview: state.runButtonReview,
	cancelLocalReview: state.cancelLocalReview,
}));
vi.mock("../../../services/page-llm-config", () => ({
	getPageFeatureSettings: () => ({ model: "opus", thinkingLevel: "medium" }),
}));

import { getReviewPath } from "../pr-review-run";
import { registerPRHandlers } from "../pr-handlers";

const mock = ipcMain as unknown as {
	invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<unknown>;
	emit: (c: string, ...a: unknown[]) => boolean;
};
const invoke = (channel: string, ...args: unknown[]) => mock.invokeHandler(channel, {}, ...args);
const window = { webContents: { send: vi.fn() } };
let windowOpen = true;
registerPRHandlers(() => (windowOpen ? (window as never) : null));

let root: string;
let project: Project;
const route = (endpoint: string, answer: unknown) => state.routes.set(`/repos/acme/shop${endpoint}`, answer);
const saveReview = (prNumber: number, fields: Record<string, unknown> = {}) => {
	mkdirSync(path.dirname(getReviewPath(project, prNumber)), { recursive: true });
	writeFileSync(
		getReviewPath(project, prNumber),
		JSON.stringify({ pr_number: prNumber, repo: "acme/shop", success: true, findings: [], summary: "ok", ...fields }),
	);
};
const savedReview = (prNumber: number) => JSON.parse(readFileSync(getReviewPath(project, prNumber), "utf-8"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "pr-handlers-"));
	project = { id: "p1", name: "shop", path: root } as Project;
	state.project = project;
	state.config = { token: "pat-test-0000", repo: "acme/shop" };
	state.routes.clear();
	state.fetches = [];
	state.remote = undefined;
	windowOpen = true;
	for (const fn of [
		...Object.values(state.actions),
		...Object.values(state.server),
		state.graphql,
		state.loadPRLogs,
		state.post,
		state.runButtonReview,
		state.cancelLocalReview,
	]) {
		(fn as ReturnType<typeof vi.fn>).mockReset();
	}
	state.server.cancelServerReview.mockReturnValue(false);
	state.cancelLocalReview.mockReturnValue(false);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("listing and reading PRs", () => {
	it("lists the first page and the next ones, and nothing without a configuration or a project", async () => {
		state.graphql.mockResolvedValue({ prs: [{ number: 1 }], hasNextPage: true, endCursor: "c1" });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_LIST, "p1")).resolves.toMatchObject({ endCursor: "c1" });
		await invoke(IPC_CHANNELS.GITHUB_PR_LIST_MORE, "p1", "c1");
		expect(state.graphql.mock.calls).toEqual([
			[state.config, null, "initial"],
			[state.config, "c1", "pagination"],
		]);

		const empty = { prs: [], hasNextPage: false, endCursor: null };
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_LIST, "other")).resolves.toEqual(empty);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_LIST_MORE, "other", "c1")).resolves.toEqual(empty);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_LIST, "p1")).resolves.toEqual(empty);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_LIST_MORE, "p1", "c1")).resolves.toEqual(empty);
	});

	it("reads one PR with its files, with defaults for missing counts", async () => {
		route("/pulls/7", {
			number: 7,
			title: "Add cart",
			state: "open",
			user: { login: "ana" },
			head: { ref: "feat/cart" },
			base: { ref: "develop" },
			assignees: [{ login: "bo" }],
			created_at: "c",
			updated_at: "u",
			html_url: "https://github.com/acme/shop/pull/7",
		});
		route("/pulls/7/files", [{ filename: "cart.ts", status: "added" }]);

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET, "p1", 7)).resolves.toEqual({
			number: 7,
			title: "Add cart",
			body: "",
			state: "open",
			author: { login: "ana" },
			headRefName: "feat/cart",
			baseRefName: "develop",
			additions: 0,
			deletions: 0,
			changedFiles: 0,
			assignees: [{ login: "bo" }],
			files: [{ path: "cart.ts", additions: 0, deletions: 0, status: "added" }],
			createdAt: "c",
			updatedAt: "u",
			htmlUrl: "https://github.com/acme/shop/pull/7",
		});
	});

	it("keeps the counts GitHub gives, and answers null when the PR cannot be read", async () => {
		route("/pulls/8", {
			number: 8,
			title: "t",
			body: "b",
			state: "open",
			user: { login: "ana" },
			head: { ref: "h" },
			base: { ref: "b" },
			additions: 3,
			deletions: 1,
			changed_files: 2,
		});
		route("/pulls/8/files", [{ filename: "a.ts", additions: 3, deletions: 1, status: "modified" }]);

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET, "p1", 8)).resolves.toMatchObject({
			body: "b",
			additions: 3,
			deletions: 1,
			changedFiles: 2,
			assignees: [],
			files: [{ path: "a.ts", additions: 3, deletions: 1, status: "modified" }],
		});
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET, "p1", 9)).resolves.toBeNull();
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET, "p1", 8)).resolves.toBeNull();
	});

	it("reads the diff through gh, null on failure or without a configuration", async () => {
		state.actions.prDiff.mockResolvedValueOnce("diff --git a b").mockRejectedValueOnce(new Error("gh failed"));

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_DIFF, "p1", 7)).resolves.toBe("diff --git a b");
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_DIFF, "p1", 7)).resolves.toBeNull();
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_DIFF, "p1", 7)).resolves.toBeNull();
	});

	it("reads the review logs", async () => {
		state.loadPRLogs.mockReturnValue({ prNumber: 7 });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_LOGS, "p1", 7)).resolves.toEqual({ prNumber: 7 });
		expect(state.loadPRLogs).toHaveBeenCalledWith(project, 7);
	});
});

describe("saved reviews", () => {
	it("reads one review, or a batch, from disk", async () => {
		saveReview(7, { summary: "first" });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEW, "p1", 7)).resolves.toMatchObject({ summary: "first" });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH, "p1", [7, 8])).resolves.toEqual({
			7: expect.objectContaining({ summary: "first" }),
			8: null,
		});
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH, "other", [7])).resolves.toEqual({});
	});

	it("asks the server for a server project's reviews", async () => {
		state.remote = { id: "srv" };
		state.server.serverReviews.mockResolvedValue({ 7: { summary: "server" } });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEW, "p1", 7)).resolves.toEqual({ summary: "server" });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEW, "p1", 8)).resolves.toBeNull();
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_GET_REVIEWS_BATCH, "p1", [7])).resolves.toEqual({
			7: { summary: "server" },
		});
		expect(state.server.serverReviews).toHaveBeenLastCalledWith({ id: "srv" }, [7]);
	});

	it("posts the chosen findings and records them on the saved review", async () => {
		saveReview(7, { posted_finding_ids: ["f-0"] });
		state.post.mockResolvedValue({ reviewId: 55, findings: [{ id: "f-1" }, { id: "f-0" }] });

		await expect(
			invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7, ["f-1"], { forceApprove: true }),
		).resolves.toBe(true);

		expect(state.post).toHaveBeenCalledWith(
			state.config,
			7,
			expect.objectContaining({ prNumber: 7 }),
			["f-1"],
			{ forceApprove: true },
		);
		expect(savedReview(7)).toMatchObject({
			review_id: 55,
			has_posted_findings: true,
			posted_finding_ids: ["f-0", "f-1"],
			posted_at: expect.any(String),
		});
	});

	it("starts the posted ids of a review that had none", async () => {
		saveReview(7);
		state.post.mockResolvedValue({ reviewId: 56, findings: [{ id: "f-1" }] });

		await invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7);

		expect(savedReview(7).posted_finding_ids).toEqual(["f-1"]);
	});

	it("posts nothing without a saved review or a configuration, and fails when GitHub refuses", async () => {
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7)).resolves.toBe(false);
		saveReview(7);
		state.post.mockRejectedValue(new Error("422"));
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7)).resolves.toBe(false);
		expect(savedReview(7)).not.toHaveProperty("review_id");
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "other", 7)).resolves.toBe(false);
	});

	it("sends a server project's post to the server", async () => {
		state.remote = { id: "srv" };
		state.server.postServerReview.mockResolvedValue(true);

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7, ["f-1"])).resolves.toBe(true);
		expect(state.server.postServerReview).toHaveBeenCalledWith({ id: "srv" }, 7, ["f-1"], undefined);
	});

	it("marks a saved review as posted, false when there is none", async () => {
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED, "p1", 7)).resolves.toBe(false);
		saveReview(7);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED, "p1", 7)).resolves.toBe(true);
		expect(savedReview(7)).toMatchObject({ has_posted_findings: true, posted_at: expect.any(String) });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED, "other", 7)).resolves.toBe(false);

		state.remote = { id: "srv" };
		state.server.markServerReviewPosted.mockResolvedValue(true);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MARK_REVIEW_POSTED, "p1", 7)).resolves.toBe(true);
	});

	it("deletes the posted review on GitHub and forgets its id", async () => {
		saveReview(7, { review_id: 55 });
		route("/pulls/7/reviews/55", {});

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "p1", 7)).resolves.toBe(true);

		expect(state.fetches).toEqual([{ endpoint: "/repos/acme/shop/pulls/7/reviews/55", options: { method: "DELETE" } }]);
		expect(savedReview(7)).not.toHaveProperty("review_id");
	});

	it("deletes nothing without a posted review or a configuration, and fails when GitHub refuses", async () => {
		saveReview(7);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "p1", 7)).resolves.toBe(false);
		saveReview(7, { review_id: 55 });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "p1", 7)).resolves.toBe(false);
		expect(savedReview(7).review_id).toBe(55);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "other", 7)).resolves.toBe(false);
	});
});

describe("acting on a PR", () => {
	it("comments, merges and assigns, false on failure or without a project", async () => {
		state.actions.prComment.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("403"));
		state.actions.prMerge.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("405"));
		route("/issues/7/assignees", {});

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, "p1", 7, "LGTM")).resolves.toBe(true);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, "p1", 7, "LGTM")).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, "other", 7, "LGTM")).resolves.toBe(false);
		expect(state.actions.prComment).toHaveBeenCalledWith(project, 7, "LGTM");

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MERGE, "p1", 7, "rebase")).resolves.toBe(true);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MERGE, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MERGE, "other", 7)).resolves.toBe(false);
		expect(state.actions.prMerge.mock.calls.map((c) => c[2])).toEqual(["rebase", "squash"]);

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_ASSIGN, "p1", 7, "ana")).resolves.toBe(true);
		expect(state.fetches.at(-1)).toEqual({
			endpoint: "/repos/acme/shop/issues/7/assignees",
			options: { method: "POST", body: JSON.stringify({ assignees: ["ana"] }) },
		});
		state.routes.clear();
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_ASSIGN, "p1", 7, "ana")).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_ASSIGN, "other", 7, "ana")).resolves.toBe(false);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_ASSIGN, "p1", 7, "ana")).resolves.toBe(false);
	});

	it("updates the branch, already up to date included", async () => {
		state.actions.prUpdateBranch
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Branch is already up to date"));

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH, "p1", 7)).resolves.toEqual({ success: true });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH, "p1", 7)).resolves.toEqual({ success: true });
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH, "other", 7)).resolves.toEqual({
			success: false,
			error: "Project not found",
		});
	});

	it.each([
		["HTTP 403 Resource not accessible", "You don't have permission to update this branch."],
		["missing permission", "You don't have permission to update this branch."],
		["HTTP 401 Bad credentials", "Authentication failed. Try running 'gh auth login' to re-authenticate."],
		["Auth required", "Authentication failed. Try running 'gh auth login' to re-authenticate."],
		["invalid token", "Authentication failed. Try running 'gh auth login' to re-authenticate."],
		["HTTP 404", "Pull request not found. It may have been closed or deleted."],
		["PR not found", "Pull request not found. It may have been closed or deleted."],
		["HTTP 429", "GitHub API rate limit exceeded. Please wait and try again."],
		["Rate limit exceeded", "GitHub API rate limit exceeded. Please wait and try again."],
		["merge conflict", "Cannot update branch due to merge conflicts. Resolve conflicts manually."],
		["Protected branch", "Branch protection rules prevent this update."],
		["blocked by branch protection", "Branch protection rules prevent this update."],
		["getaddrinfo ENOTFOUND api.github.com", "Network error. Check your internet connection and try again."],
		["connect ECONNREFUSED", "Network error. Check your internet connection and try again."],
		["ETIMEDOUT", "Network error. Check your internet connection and try again."],
		["something odd", "something odd"],
	])("says %s as %s", async (message, error) => {
		state.actions.prUpdateBranch.mockRejectedValue(new Error(message));

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH, "p1", 7)).resolves.toEqual({ success: false, error });
	});

	it("keeps a failure that is not an error as text", async () => {
		state.actions.prUpdateBranch.mockRejectedValue("odd");

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH, "p1", 7)).resolves.toEqual({ success: false, error: "odd" });
	});
});

describe("reviews from the buttons", () => {
	const emit = (channel: string, ...args: unknown[]) => mock.emit(channel, {}, ...args);

	it("runs a local review or follow-up in the project", async () => {
		emit(IPC_CHANNELS.GITHUB_PR_REVIEW, "p1", 7);
		emit(IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW, "p1", 8);
		await vi.waitFor(() => expect(state.runButtonReview).toHaveBeenCalledTimes(2));

		expect(state.runButtonReview.mock.calls).toEqual([
			[project, 7, window, "review"],
			[project, 8, window, "followup"],
		]);
	});

	it("sends a server project's review to the server, with the page's model", async () => {
		state.remote = { id: "srv" };

		emit(IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW, "p1", 8);

		await vi.waitFor(() =>
			expect(state.server.startServerReview).toHaveBeenCalledWith({ id: "srv" }, 8, true, window, {
				model: "claude-opus-5-5",
				thinkingLevel: "medium",
			}),
		);
		expect(state.runButtonReview).not.toHaveBeenCalled();
	});

	it("starts nothing without a window", async () => {
		windowOpen = false;
		emit(IPC_CHANNELS.GITHUB_PR_REVIEW, "p1", 7);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.runButtonReview).not.toHaveBeenCalled();
		expect(state.server.startServerReview).not.toHaveBeenCalled();
	});

	it("cancels on the server first, then here", async () => {
		state.server.cancelServerReview.mockReturnValueOnce(true);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL, "p1", 7)).resolves.toBe(true);
		expect(state.cancelLocalReview).not.toHaveBeenCalled();

		state.cancelLocalReview.mockReturnValueOnce(true);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL, "p1", 7)).resolves.toBe(true);
		expect(state.cancelLocalReview).toHaveBeenCalledWith("p1", 7);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL, "p1", 7)).resolves.toBe(false);
	});
});

describe("freshness of a review", () => {
	it("compares the saved review with the PR's head", async () => {
		saveReview(7, { reviewed_commit_sha: "aaa" });
		route("/pulls/7", { head: { sha: "aaa" } });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS, "p1", 7)).resolves.toMatchObject({
			hasNewCommits: false,
			currentHeadCommit: "aaa",
		});
	});

	it("reads a server project's review from the server", async () => {
		project = { ...project, remote: { serverId: "s" } } as unknown as Project;
		state.project = project;
		state.server.serverReviews.mockResolvedValue({ 7: { prNumber: 7, reviewedCommitSha: "aaa", findings: [] } });
		route("/pulls/7", { head: { sha: "aaa" } });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS, "p1", 7)).resolves.toMatchObject({
			lastReviewedCommit: "aaa",
		});
	});

	it("has no new commit without a review, a configuration or a project", async () => {
		const none = { hasNewCommits: false, newCommitCount: 0 };
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS, "p1", 7)).resolves.toEqual(none);
		saveReview(7, { reviewed_commit_sha: "aaa" });
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS, "p1", 7)).resolves.toEqual(none);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS, "other", 7)).resolves.toEqual(none);
		expect(state.fetches).toEqual([]);
	});

	it("checks merge readiness, unknown without a configuration", async () => {
		route("/pulls/7", { draft: true, mergeable: true, mergeable_state: "clean", head: { sha: "h" } });
		route("/commits/h/status", { state: "success", total_count: 1 });

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS, "p1", 7)).resolves.toMatchObject({
			isDraft: true,
			ciStatus: "passing",
			blockers: ["PR is in draft mode"],
		});
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS, "p1", 7)).resolves.toMatchObject({
			mergeable: "UNKNOWN",
			blockers: [],
		});
	});
});

describe("workflows awaiting approval", () => {
	it("lists the runs of the PR's head that wait for approval", async () => {
		route("/pulls/7", { head: { sha: "h1" } });
		route("/actions/runs?status=action_required&per_page=100", {
			workflow_runs: [
				{ id: 1, name: "CI", html_url: "u1", head_sha: "h1", workflow: { name: "CI" } },
				{ id: 2, name: "Lint", html_url: "u2", head_sha: "h1" },
				{ id: 3, name: "Other", html_url: "u3", head_sha: "h2" },
			],
		});

		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual({
			awaiting_approval: 2,
			workflow_runs: [
				{ id: 1, name: "CI", html_url: "u1", workflow_name: "CI" },
				{ id: 2, name: "Lint", html_url: "u2", workflow_name: "Unknown" },
			],
			can_approve: true,
		});
	});

	it("has nothing to approve without a head, a run list, a configuration or a project", async () => {
		const none = { awaiting_approval: 0, workflow_runs: [], can_approve: false };
		route("/pulls/7", {});
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual(none);

		route("/pulls/7", { head: { sha: "h1" } });
		route("/actions/runs?status=action_required&per_page=100", {});
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual({
			...none,
			can_approve: true,
		});

		state.routes.clear();
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual({
			...none,
			error: "404 /repos/acme/shop/pulls/7",
		});
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "other", 7)).resolves.toEqual(none);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual({
			...none,
			error: "No GitHub config",
		});
	});

	it("approves a run, false when GitHub refuses or without a configuration", async () => {
		route("/actions/runs/1/approve", {});

		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE, "p1", 1)).resolves.toBe(true);
		expect(state.fetches.at(-1)?.options).toEqual({ method: "POST" });
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE, "p1", 2)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE, "other", 1)).resolves.toBe(false);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE, "p1", 1)).resolves.toBe(false);
	});
});

describe("failures that are not errors", () => {
	it("answers each handler's failure value", async () => {
		saveReview(7, { review_id: 55 });
		state.post.mockRejectedValue("down");
		state.actions.prComment.mockRejectedValue("down");
		state.actions.prMerge.mockRejectedValue("down");
		route("/pulls/7/reviews/55", "throw-text");
		route("/issues/7/assignees", "throw-text");
		route("/pulls/7", "throw-text");
		route("/actions/runs/1/approve", "throw-text");

		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_REVIEW, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_POST_COMMENT, "p1", 7, "x")).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_DELETE_REVIEW, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MERGE, "p1", 7)).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_ASSIGN, "p1", 7, "ana")).resolves.toBe(false);
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL, "p1", 7)).resolves.toEqual({
			awaiting_approval: 0,
			workflow_runs: [],
			can_approve: false,
			error: "Unknown error",
		});
		await expect(invoke(IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE, "p1", 1)).resolves.toBe(false);
	});
});

describe("review memories", () => {
	it("reads and searches the memories, none without a project", async () => {
		const dir = path.join(root, ".workpilot", "github", "memory", "shop");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "reviews_index.json"), JSON.stringify({ reviews: [{ pr_number: 1 }, { pr_number: 2 }] }));
		writeFileSync(path.join(dir, "pr_1_review.json"), JSON.stringify({ pr_number: 1, gotchas: ["token"] }));
		writeFileSync(path.join(dir, "pr_2_review.json"), JSON.stringify({ pr_number: 2 }));

		const numbers = (result: unknown) => (result as { prNumber: number }[]).map((m) => m.prNumber);
		expect(numbers(await invoke(IPC_CHANNELS.GITHUB_PR_MEMORY_GET, "p1"))).toEqual([1, 2]);
		expect(numbers(await invoke(IPC_CHANNELS.GITHUB_PR_MEMORY_GET, "p1", 1))).toEqual([1]);
		expect(numbers(await invoke(IPC_CHANNELS.GITHUB_PR_MEMORY_SEARCH, "p1", "TOKEN"))).toEqual([1]);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MEMORY_GET, "other")).resolves.toEqual([]);
		await expect(invoke(IPC_CHANNELS.GITHUB_PR_MEMORY_SEARCH, "other", "x")).resolves.toEqual([]);
	});
});
