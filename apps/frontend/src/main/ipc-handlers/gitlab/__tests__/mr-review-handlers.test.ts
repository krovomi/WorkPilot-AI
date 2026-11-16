/**
 * @vitest-environment node
 *
 * The merge request review handlers as the renderer reaches them: a server
 * project's review goes to the server, a local one runs here; the saved
 * review posts as a note and records what it posted; notes, merge (squash,
 * merge, rebase then merge), assignees, approval and cancel call GitLab or
 * the run; and whether the MR moved on since its review counts its new
 * commits. Arguments of the wrong shape never reach a handler.
 */

import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: {} as Record<string, { id: string; path: string; remote?: boolean }>,
	config: null as null | { token: string; instanceUrl: string; project: string },
	reviews: {} as Record<number, unknown>,
	serverReviews: {} as Record<number, unknown>,
	saved: {} as Record<string, unknown>,
	window: null as unknown,
	fetches: [] as { endpoint: string; options?: { method?: string; body?: string } }[],
	answer: (_endpoint: string, _options?: { method?: string }): unknown => ({}),
}));

const run = vi.hoisted(() => ({
	runButtonReview: vi.fn(async () => undefined),
	cancelLocalReview: vi.fn(() => true),
}));
const server = vi.hoisted(() => ({
	startServerMRReview: vi.fn(),
	postServerMRReview: vi.fn(async () => true),
	cancelServerMRReview: vi.fn(async () => true),
}));

vi.mock("../../github/utils/project-middleware", () => {
	const withProject = async (id: string, fn: (p: unknown) => Promise<unknown>) =>
		state.projects[id] ? fn(state.projects[id]) : null;
	return { withProjectOrNull: withProject, withForgeProjectOrNull: withProject };
});
vi.mock("../../server-review-jobs", () => ({
	serverProjectOf: (id: string) => (state.projects[id]?.remote ? state.projects[id] : undefined),
}));
vi.mock("../mr-review-run", () => ({
	...run,
	getGitLabMRSettings: () => ({ model: "claude-test", thinkingLevel: "high" }),
	getReviewResult: (_project: unknown, iid: number) => state.reviews[iid] ?? null,
	updateSavedReview: (_project: unknown, _iid: number, update: (d: Record<string, unknown>) => void) => {
		update(state.saved);
		return true;
	},
}));
vi.mock("../server-mr-review", () => ({
	...server,
	serverMRReview: async (_project: unknown, iid: number) => state.serverReviews[iid] ?? null,
}));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitLabConfig: async () => state.config,
	gitlabFetch: async (_token: string, _instance: string, endpoint: string, options?: { method?: string; body?: string }) => {
		state.fetches.push({ endpoint, options });
		return state.answer(endpoint, options);
	},
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { rebaseTimeoutMs, registerMRReviewHandlers } from "../mr-review-handlers";

type MockIpc = typeof ipcMain & {
	invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};
const invoke = (channel: string, ...args: unknown[]) =>
	(ipcMain as MockIpc).invokeHandler(channel, {}, ...args);
const send = (channel: string, ...args: unknown[]) => ipcMain.emit(channel, {}, ...args);

const MR = "/projects/acme%2Fshop/merge_requests/7";
const review = (data: Record<string, unknown> = {}) => ({
	mrIid: 7,
	summary: "Two things to look at.",
	findings: [
		{ id: "f1", severity: "high", title: "Null check", description: "x may be null", file: "a.ts", line: 3 },
		{ id: "f2", severity: "low", title: "Name", description: "rename y", file: "b.ts", line: 9 },
	],
	...data,
});

beforeAll(() => registerMRReviewHandlers(() => state.window as never));

beforeEach(() => {
	state.projects = {
		local: { id: "local", path: "/work/shop" },
		remote: { id: "remote", path: "/mirror/shop", remote: true },
	};
	state.config = { token: "glpat-test-0000", instanceUrl: "https://gitlab.example.com", project: "acme/shop" };
	state.reviews = {};
	state.serverReviews = {};
	state.saved = {};
	state.window = { webContents: { send: vi.fn() } };
	state.fetches = [];
	state.answer = () => ({});
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.GITLAB_REBASE_TIMEOUT_MS;
});

describe("arguments", () => {
	it("refuses an invoke whose arguments have the wrong shape, before the handler", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_GET_REVIEW, "local", "7/../../x")).rejects.toThrow(
			"Invalid merge request arguments",
		);
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_MERGE, "local", 7, "force")).rejects.toThrow(
			"Invalid merge request arguments",
		);
		expect(state.fetches).toEqual([]);
	});

	it("drops a send whose arguments have the wrong shape", () => {
		send(IPC_CHANNELS.GITLAB_MR_REVIEW, "local", -3);
		expect(run.runButtonReview).not.toHaveBeenCalled();
	});
});

describe("the saved review", () => {
	it("is read from the server for a server project, else from the project", async () => {
		state.reviews[7] = review({ summary: "local" });
		state.serverReviews[7] = review({ summary: "server" });
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_GET_REVIEW, "local", 7)).resolves.toMatchObject({ summary: "local" });
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_GET_REVIEW, "remote", 7)).resolves.toMatchObject({ summary: "server" });
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_GET_REVIEW, "unknown", 7)).resolves.toBeNull();
	});
});

describe("the review button", () => {
	it("runs a local project's review here, first review or follow-up", async () => {
		send(IPC_CHANNELS.GITLAB_MR_REVIEW, "local", 7);
		send(IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW, "local", 8);
		await vi.waitFor(() => expect(run.runButtonReview).toHaveBeenCalledTimes(2));
		expect(run.runButtonReview).toHaveBeenCalledWith(state.projects.local, 7, state.window, "review");
		expect(run.runButtonReview).toHaveBeenCalledWith(state.projects.local, 8, state.window, "followup");
		expect(server.startServerMRReview).not.toHaveBeenCalled();
	});

	it("starts a server project's review on the server, with the page's model", () => {
		send(IPC_CHANNELS.GITLAB_MR_REVIEW, "remote", 7);
		send(IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW, "remote", 7);
		const settings = { model: "claude-test", thinkingLevel: "high" };
		expect(server.startServerMRReview).toHaveBeenNthCalledWith(1, state.projects.remote, 7, false, state.window, settings);
		expect(server.startServerMRReview).toHaveBeenNthCalledWith(2, state.projects.remote, 7, true, state.window, settings);
		expect(run.runButtonReview).not.toHaveBeenCalled();
	});

	it("does nothing without a window to tell", async () => {
		state.window = null;
		send(IPC_CHANNELS.GITLAB_MR_REVIEW, "local", 7);
		send(IPC_CHANNELS.GITLAB_MR_REVIEW, "remote", 7);
		await new Promise((resolve) => setImmediate(resolve));
		expect(run.runButtonReview).not.toHaveBeenCalled();
		expect(server.startServerMRReview).not.toHaveBeenCalled();
	});
});

describe("posting the review", () => {
	it("posts the chosen findings as a note, then adds them to those it posted", async () => {
		state.reviews[7] = review();
		state.saved = { posted_finding_ids: ["f0", "f1"] };
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "local", 7, ["f1"])).resolves.toBe(true);

		expect(state.fetches).toHaveLength(1);
		const { endpoint, options } = state.fetches[0];
		expect(endpoint).toBe(`${MR}/notes`);
		expect(options?.method).toBe("POST");
		const { body } = JSON.parse(options?.body ?? "{}");
		expect(body).toContain("Two things to look at.");
		expect(body).toContain("Null check");
		expect(body).not.toContain("rename y");
		expect(state.saved).toEqual({ has_posted_findings: true, posted_finding_ids: ["f0", "f1"] });
	});

	it("posts every finding when none is chosen, whatever the saved list held", async () => {
		state.reviews[7] = review();
		state.saved = { posted_finding_ids: "f0" };
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "local", 7)).resolves.toBe(true);
		expect(state.saved).toEqual({ has_posted_findings: true, posted_finding_ids: ["f1", "f2"] });
	});

	it("posts nothing without a saved review or a GitLab config, and marks nothing when GitLab refuses", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "local", 7)).resolves.toBe(false);
		state.reviews[7] = review();
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "local", 7)).resolves.toBe(false);
		expect(state.fetches).toEqual([]);

		state.config = { token: "glpat-test-0000", instanceUrl: "https://gitlab.example.com", project: "acme/shop" };
		state.answer = () => {
			throw new Error("403 Forbidden");
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "local", 7)).resolves.toBe(false);
		expect(state.saved).toEqual({});
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "unknown", 7)).resolves.toBe(false);
	});

	it("leaves a server project's post to the server", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_REVIEW, "remote", 7, ["f2"])).resolves.toBe(true);
		expect(server.postServerMRReview).toHaveBeenCalledWith(state.projects.remote, 7, ["f2"]);
		expect(state.fetches).toEqual([]);
	});
});

describe("acting on the merge request", () => {
	it("posts a note", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_NOTE, "local", 7, "Thanks!")).resolves.toBe(true);
		expect(state.fetches).toEqual([
			{ endpoint: `${MR}/notes`, options: { method: "POST", body: JSON.stringify({ body: "Thanks!" }) } },
		]);
	});

	it("assigns and approves", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_ASSIGN, "local", 7, [3, 4])).resolves.toBe(true);
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_APPROVE, "remote", 7)).resolves.toBe(true);
		expect(state.fetches).toEqual([
			{ endpoint: MR, options: { method: "PUT", body: JSON.stringify({ assignee_ids: [3, 4] }) } },
			{ endpoint: `${MR}/approve`, options: { method: "POST" } },
		]);
	});

	it("answers false without a project or a config, or when GitLab refuses", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_APPROVE, "unknown", 7)).resolves.toBe(false);
		state.config = null;
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_APPROVE, "local", 7)).resolves.toBe(false);
		expect(state.fetches).toEqual([]);
		state.config = { token: "glpat-test-0000", instanceUrl: "https://gitlab.example.com", project: "acme/shop" };
		state.answer = () => {
			throw new Error("401 Unauthorized");
		};
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_POST_NOTE, "local", 7, "x")).resolves.toBe(false);
	});

	it("squashes by default, and merges as it is when asked", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_MERGE, "local", 7)).resolves.toBe(true);
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_MERGE, "local", 7, "merge")).resolves.toBe(true);
		expect(state.fetches).toEqual([
			{ endpoint: `${MR}/merge`, options: { method: "PUT", body: JSON.stringify({ squash: true }) } },
			{ endpoint: `${MR}/merge`, options: { method: "PUT", body: "{}" } },
		]);
	});

	it("rebases on GitLab, waits for the rebase, then merges", async () => {
		vi.useFakeTimers();
		let polls = 0;
		state.answer = (endpoint, options) =>
			endpoint === MR && !options ? { rebase_in_progress: ++polls < 3 } : {};
		const merged = invoke(IPC_CHANNELS.GITLAB_MR_MERGE, "local", 7, "rebase");
		await vi.advanceTimersByTimeAsync(2000);
		await expect(merged).resolves.toBe(true);
		expect(state.fetches.map((f) => `${f.options?.method ?? "GET"} ${f.endpoint}`)).toEqual([
			`PUT ${MR}/rebase`,
			`GET ${MR}`,
			`GET ${MR}`,
			`GET ${MR}`,
			`PUT ${MR}/merge`,
		]);
	});

	it("does not merge when the rebase outlasts its timeout", async () => {
		vi.useFakeTimers();
		process.env.GITLAB_REBASE_TIMEOUT_MS = "2500";
		state.answer = (endpoint, options) => (endpoint === MR && !options ? { rebase_in_progress: true } : {});
		const merged = invoke(IPC_CHANNELS.GITLAB_MR_MERGE, "local", 7, "rebase");
		await vi.advanceTimersByTimeAsync(3000);
		await expect(merged).resolves.toBe(false);
		expect(state.fetches.some((f) => f.endpoint === `${MR}/merge`)).toBe(false);
	});

	it("waits a minute for a rebase unless told otherwise", () => {
		expect(rebaseTimeoutMs(undefined)).toBe(60_000);
		expect(rebaseTimeoutMs("")).toBe(60_000);
		expect(rebaseTimeoutMs("soon")).toBe(60_000);
		expect(rebaseTimeoutMs("-5")).toBe(60_000);
		expect(rebaseTimeoutMs("0")).toBe(60_000);
		expect(rebaseTimeoutMs("90000")).toBe(90_000);
		process.env.GITLAB_REBASE_TIMEOUT_MS = "1234";
		expect(rebaseTimeoutMs()).toBe(1234);
	});
});

describe("cancelling a review", () => {
	it("cancels on the server for a server project, else here", async () => {
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL, "remote", 7)).resolves.toBe(true);
		expect(server.cancelServerMRReview).toHaveBeenCalledWith("remote", 7);
		run.cancelLocalReview.mockReturnValueOnce(false);
		await expect(invoke(IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL, "local", 7)).resolves.toBe(false);
		expect(run.cancelLocalReview).toHaveBeenCalledWith("local", 7);
	});
});

describe("new commits since the review", () => {
	const check = (projectId = "local") => invoke(IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS, projectId, 7);
	const commits = (...ids: string[]) => ids.map((id) => ({ id }));

	it("finds none without a review that names its commit, or without a config", async () => {
		await expect(check()).resolves.toEqual({ hasNewCommits: false });
		state.reviews[7] = review();
		await expect(check()).resolves.toEqual({ hasNewCommits: false });
		state.reviews[7] = review({ reviewedCommitSha: "aaa" });
		state.config = null;
		await expect(check()).resolves.toEqual({ hasNewCommits: false });
		await expect(check("unknown")).resolves.toEqual({ hasNewCommits: false });
		expect(state.fetches).toEqual([]);
	});

	it("finds none while the head is the reviewed commit", async () => {
		state.reviews[7] = review({ reviewedCommitSha: "aaa" });
		state.answer = () => ({ sha: "aaa" });
		await expect(check()).resolves.toEqual({ hasNewCommits: false, currentSha: "aaa", reviewedSha: "aaa" });
	});

	it("counts the commits after the reviewed one, newest first", async () => {
		state.reviews[7] = review({ reviewedCommitSha: "aaa" });
		state.answer = (endpoint) =>
			endpoint === MR ? { diff_refs: { head_sha: "ccc" } } : commits("ccc", "bbb", "aaa", "000");
		await expect(check()).resolves.toEqual({
			hasNewCommits: true,
			currentSha: "ccc",
			reviewedSha: "aaa",
			newCommitCount: 2,
		});
		expect(state.fetches[1].endpoint).toBe(`${MR}/commits?per_page=100`);
	});

	it("counts every commit it reads when the reviewed one is gone (a force push), and at least one", async () => {
		state.reviews[7] = review({ reviewedCommitSha: "aaa" });
		state.answer = (endpoint) => (endpoint === MR ? { sha: "zzz" } : commits("zzz", "yyy"));
		await expect(check()).resolves.toMatchObject({ hasNewCommits: true, newCommitCount: 2 });

		state.answer = (endpoint) => (endpoint === MR ? { sha: "zzz" } : commits("aaa"));
		await expect(check()).resolves.toMatchObject({ hasNewCommits: true, newCommitCount: 1 });
	});

	it("reads a server project's review from the server", async () => {
		state.serverReviews[7] = review({ reviewedCommitSha: "aaa" });
		state.answer = (endpoint) => (endpoint === MR ? { sha: "bbb" } : commits("bbb", "aaa"));
		await expect(check("remote")).resolves.toMatchObject({ hasNewCommits: true, newCommitCount: 1 });
	});

	it("finds none when GitLab cannot be read", async () => {
		state.reviews[7] = review({ reviewedCommitSha: "aaa" });
		state.answer = () => {
			throw new Error("502 Bad Gateway");
		};
		await expect(check()).resolves.toEqual({ hasNewCommits: false });
	});
});
