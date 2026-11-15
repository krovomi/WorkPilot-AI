/**
 * @vitest-environment node
 *
 * The issue list (pages of 50 issues gathered from GitHub's mixed list of
 * issues and pull requests, or every issue for search), one issue and its
 * comments, against a stand-in GitHub. What the renderer sends (state, page,
 * issue number) is checked before it becomes part of an API URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	config: null as { token: string; repo: string } | null,
}));

vi.mock("../../server-feature-files", () => ({ featureProject: () => state.project }));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitHubConfig: () => state.config,
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerIssueHandlers } from "../issue-handlers";

type Issue = Record<string, unknown>;
type Result = {
	success: boolean;
	error?: string;
	data?: { issues: Issue[]; hasMore: boolean } & Record<string, unknown>;
};
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

function apiIssue(n: number, pr = false): Issue {
	return {
		id: 1000 + n,
		number: n,
		title: `Issue ${n}`,
		body: "body",
		state: "open",
		labels: [{ name: "bug" }],
		assignees: [{ login: "ana", avatar_url: "https://a.invalid/ana" }],
		user: { login: "bo", avatar_url: "https://a.invalid/bo" },
		milestone: null,
		created_at: "2026-11-01T00:00:00Z",
		updated_at: "2026-11-02T00:00:00Z",
		closed_at: null,
		comments: 2,
		url: `https://api.github.com/repos/acme/shop/issues/${n}`,
		html_url: `https://github.com/acme/shop/issues/${n}`,
		...(pr ? { pull_request: {} } : {}),
	};
}

/** API pages of `size` items numbered from `from`, every `prEvery`-th one a pull request. */
function pages(count: number, size: number, prEvery = 0, from = 1): Issue[][] {
	return Array.from({ length: count }, (_, p) =>
		Array.from({ length: size }, (_, i) => {
			const n = from + p * size + i;
			return apiIssue(n, prEvery > 0 && n % prEvery === 0);
		}),
	);
}

const fetchMock = vi.fn();
function serve(apiPages: unknown[]) {
	fetchMock.mockImplementation(async (url: string) => {
		const page = Number(new URL(url).searchParams.get("page"));
		return new Response(JSON.stringify(apiPages[page - 1] ?? []), { status: 200 });
	});
}

registerIssueHandlers();

beforeEach(() => {
	state.project = { id: "p", path: "/repo" };
	state.config = { token: "pat-test-0000", repo: "acme/shop" };
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GITHUB_GET_ISSUES", () => {
	it("returns the first 50 issues, without the pull requests, mapped for the app", async () => {
		serve(pages(1, 100, 4));

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "open", 1, false);

		expect(result.success).toBe(true);
		const issues = result.data?.issues ?? [];
		expect(issues).toHaveLength(50);
		expect(issues.some((i) => Number(i.number) % 4 === 0)).toBe(false);
		expect(issues[0]).toEqual({
			id: 1001,
			number: 1,
			title: "Issue 1",
			body: "body",
			state: "open",
			labels: [{ name: "bug" }],
			assignees: [{ login: "ana", avatarUrl: "https://a.invalid/ana" }],
			author: { login: "bo", avatarUrl: "https://a.invalid/bo" },
			milestone: null,
			createdAt: "2026-11-01T00:00:00Z",
			updatedAt: "2026-11-02T00:00:00Z",
			closedAt: null,
			commentsCount: 2,
			url: "https://api.github.com/repos/acme/shop/issues/1",
			htmlUrl: "https://github.com/acme/shop/issues/1",
			repoFullName: "acme/shop",
		});
		// 75 issues on that page: more than this page holds.
		expect(result.data?.hasMore).toBe(true);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"https://api.github.com/repos/acme/shop/issues?state=open&per_page=100&sort=updated&page=1",
		);
	});

	it("gathers several API pages for a later page, and stops when GitHub has no more", async () => {
		// 100 + 100 + 30 items, one in two a pull request: 115 issues.
		serve([...pages(2, 100, 2), ...pages(1, 30, 2, 201)]);

		const page3 = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "all", 3);

		expect(page3.data?.issues).toHaveLength(15);
		expect(page3.data?.hasMore).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("stops at an empty API page and at an answer that is not a list", async () => {
		// A full API page of 75 issues, then nothing: page 2 holds the last 25.
		serve([pages(1, 100, 4)[0], []]);
		const last = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "open", 2);
		expect(last.data?.issues).toHaveLength(25);
		expect(last.data?.hasMore).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockReset();
		serve([{ message: "odd" }]);
		const odd = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "open", 1);
		expect(odd.data).toEqual({ issues: [], hasMore: false });
	});

	it("does not promise more when a repository of pull requests leaves the page empty", async () => {
		// Five full pages of pull requests only: the fetch limit is reached with nothing to show.
		serve(pages(5, 100, 1));

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "open", 1);

		expect(result.data).toEqual({ issues: [], hasMore: false });
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("fetches every issue for search, until a short page", async () => {
		serve([...pages(1, 100, 10), ...pages(1, 40, 10, 101)]);

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "closed", 1, true);

		expect(result.data?.issues).toHaveLength(126);
		expect(result.data?.hasMore).toBe(false);
		expect(String(fetchMock.mock.calls[1][0])).toContain("state=closed&per_page=100&sort=updated&page=2");
	});

	it("stops the search fetch at an empty or odd page", async () => {
		serve([pages(1, 100)[0], {}]);

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", "open", 1, true);

		expect(result.data?.issues).toHaveLength(100);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reads a left-out state and page as open and 1", async () => {
		serve([[apiIssue(1)]]);

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", null, undefined);

		expect(result.data?.issues).toHaveLength(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain("state=open&");
		expect(String(fetchMock.mock.calls[0][0])).toContain("&page=1");
	});

	it.each([
		["open&per_page=1", 1],
		["OPEN", 1],
		["open", 0],
		["open", -1],
		["open", 1.5],
		["open", "2"],
	])("refuses the query state=%j page=%j before calling GitHub", async (issueState, page) => {
		const result = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p", issueState, page);

		expect(result).toEqual({ success: false, error: "Invalid issue query" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers an unknown project, a missing configuration, a bad reference and a failed call", async () => {
		state.project = undefined;
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "nope")).error).toBe("Project not found");

		state.project = { id: "p" };
		state.config = null;
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p")).error).toBe(
			"No GitHub token or repository configured",
		);

		state.config = { token: "pat-test-0000", repo: "acme/shop/../x" };
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p")).error).toMatch(/^Invalid repository format/);

		state.config = { token: "pat-test-0000", repo: "acme/shop" };
		fetchMock.mockRejectedValueOnce(new Error("rate limited"));
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p")).error).toBe("rate limited");
		fetchMock.mockRejectedValueOnce("odd");
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_ISSUES, "p")).error).toBe("Failed to fetch issues");
	});
});

describe("GITHUB_GET_ISSUE and GITHUB_GET_ISSUE_COMMENTS", () => {
	it("reads one issue and its comments", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(JSON.stringify(apiIssue(7)), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, body: "hi" }]), { status: 200 }));

		const issue = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUE, "p", 7);
		const comments = await invoke(IPC_CHANNELS.GITHUB_GET_ISSUE_COMMENTS, "p", 7);

		expect(issue.data).toMatchObject({ number: 7, repoFullName: "acme/shop", commentsCount: 2 });
		expect(comments.data).toEqual([{ id: 1, body: "hi" }]);
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
			"https://api.github.com/repos/acme/shop/issues/7",
			"https://api.github.com/repos/acme/shop/issues/7/comments",
		]);
	});

	it.each([
		[IPC_CHANNELS.GITHUB_GET_ISSUE],
		[IPC_CHANNELS.GITHUB_GET_ISSUE_COMMENTS],
	])("%s refuses a number that is not one, and answers each failure", async (channel) => {
		for (const bad of ["1/../../../user", "7", 0, -3, 2.5, Number.NaN, null]) {
			expect(await invoke(channel, "p", bad)).toEqual({ success: false, error: "Invalid issue number" });
		}
		expect(fetchMock).not.toHaveBeenCalled();

		state.project = undefined;
		expect((await invoke(channel, "nope", 1)).error).toBe("Project not found");
		state.project = { id: "p" };
		state.config = null;
		expect((await invoke(channel, "p", 1)).error).toBe("No GitHub token or repository configured");
		state.config = { token: "pat-test-0000", repo: "acme" };
		expect((await invoke(channel, "p", 1)).error).toMatch(/^Invalid repository format/);
		state.config = { token: "pat-test-0000", repo: "acme/shop" };
		fetchMock.mockRejectedValueOnce(new Error("Not Found"));
		expect((await invoke(channel, "p", 1)).error).toBe("Not Found");
		fetchMock.mockRejectedValueOnce(undefined);
		expect((await invoke(channel, "p", 1)).error).toMatch(/^Failed to fetch issue/);
	});
});
