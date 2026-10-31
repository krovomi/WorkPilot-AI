/**
 * GitHub for a server project: every call goes to the server, by project id,
 * and is made there with the person's own token. Nothing is sent to GitHub
 * from this computer, and nothing of this computer's `gh` login is used.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	execFileSync: vi.fn(),
	execFile: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("node:child_process", () => ({
	execFileSync: mocks.execFileSync,
	execFile: mocks.execFile,
}));

import { fetchPRsFromGraphQL } from "../pr-graphql";
import { prComment, prDiff, prMerge, prUpdateBranch } from "../pr-actions";
import { githubRepoOf, isServerHandle, serverGitHubConfig } from "../server-relay";
import { getGitHubConfig, githubFetch } from "../utils";

function serverProject(repoUrl = "https://github.com/acme/shop.git"): Project {
	return {
		id: "p-1",
		path: "/nowhere/mirror",
		remote: { repoUrl, defaultBranch: "main", role: "member" },
	} as unknown as Project;
}

function answered(answer: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: answer });
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.execFileSync.mockReset();
	mocks.execFile.mockReset();
	mocks.fetch.mockReset();
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("a server project's GitHub", () => {
	it("is the repository the server cloned, and its token is a handle", () => {
		expect(githubRepoOf("https://github.com/acme/shop.git")).toBe("acme/shop");
		expect(githubRepoOf("git@github.com:acme/shop.git")).toBe("acme/shop");
		expect(githubRepoOf("https://gitlab.com/acme/shop.git")).toBeNull();
		expect(githubRepoOf("https://github.com.evil.test/acme/shop")).toBeNull();

		const config = getGitHubConfig(serverProject());
		expect(config).toEqual(serverGitHubConfig(serverProject()));
		expect(config?.repo).toBe("acme/shop");
		expect(isServerHandle(config?.token ?? "")).toBe(true);
		expect(config?.token).not.toMatch(/^gh[pousr]_/);
		expect(getGitHubConfig(serverProject("https://gitlab.com/a/b.git"))).toBeNull();
		// No gh login is asked for a server project.
		expect(mocks.execFileSync).not.toHaveBeenCalled();
	});

	it("reads through the server's read route, by project id", async () => {
		const config = getGitHubConfig(serverProject());
		answered({ status: 200, body: [{ number: 3 }] });
		const issues = await githubFetch(
			config?.token ?? "",
			"/repos/acme/shop/issues?state=open",
		);
		expect(issues).toEqual([{ number: 3 }]);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/github/read?project_id=p-1",
			"POST",
			{ method: "GET", endpoint: "/repos/acme/shop/issues?state=open" },
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("writes through the write route, and fails like githubFetch", async () => {
		const config = getGitHubConfig(serverProject());
		answered({ status: 201, body: { id: 9 } });
		await githubFetch(config?.token ?? "", "/repos/acme/shop/issues/3/assignees", {
			method: "POST",
			body: JSON.stringify({ assignees: ["ada"] }),
		});
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/features/forge/github/write?project_id=p-1",
			"POST",
			{
				method: "POST",
				endpoint: "/repos/acme/shop/issues/3/assignees",
				body: { assignees: ["ada"] },
			},
		);

		answered({ status: 404, body: { message: "Not Found" } });
		await expect(githubFetch(config?.token ?? "", "/repos/acme/shop/issues/99")).rejects.toThrow(
			/GitHub API error: 404/,
		);

		// The server's refusal (no token stored there) is the error shown.
		mocks.authedFetch.mockResolvedValueOnce({
			ok: false,
			error: "Add your GitHub token in Settings → My tokens on the server",
		});
		await expect(githubFetch(config?.token ?? "", "/repos/acme/shop")).rejects.toThrow(
			/My tokens on the server/,
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("lists the open pull requests with the server's own query", async () => {
		const config = getGitHubConfig(serverProject());
		answered({
			status: 200,
			body: {
				data: {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: true, endCursor: "c2" },
							nodes: [
								{
									number: 7,
									title: "Fix",
									body: null,
									state: "OPEN",
									author: { login: "ada" },
									headRefName: "fix",
									baseRefName: "main",
									additions: 1,
									deletions: 2,
									changedFiles: 1,
									assignees: { nodes: [] },
									createdAt: "2026-10-31T00:00:00Z",
									updatedAt: "2026-10-31T00:00:00Z",
									url: "https://github.com/acme/shop/pull/7",
								},
							],
						},
					},
				},
			},
		});
		const page = await fetchPRsFromGraphQL(
			config as { token: string; repo: string },
			"c1",
			"test",
		);
		expect(page.prs.map((pr) => pr.number)).toEqual([7]);
		expect(page.endCursor).toBe("c2");
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/github/pulls?project_id=p-1",
			"POST",
			{ first: 100, after: "c1" },
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("does the PR view's actions through the server, never with gh", async () => {
		const project = serverProject();
		answered({ status: 200, text: "diff --git a/x b/x\n" });
		expect(await prDiff(project, 7)).toMatch(/^diff --git/);
		expect(mocks.authedFetch).toHaveBeenLastCalledWith(
			"/api/features/forge/github/read?project_id=p-1",
			"POST",
			{ endpoint: "/repos/acme/shop/pulls/7", accept: "diff" },
		);

		answered({ status: 201, body: {} });
		await prComment(project, 7, "Looks good");
		answered({ status: 200, body: { merged: true } });
		await prMerge(project, 7, "squash");
		answered({ status: 202, body: {} });
		await prUpdateBranch(project, 7);
		const sent = mocks.authedFetch.mock.calls.slice(1).map((call) => call[2]);
		expect(sent).toEqual([
			{
				method: "POST",
				endpoint: "/repos/acme/shop/issues/7/comments",
				body: { body: "Looks good" },
			},
			{
				method: "PUT",
				endpoint: "/repos/acme/shop/pulls/7/merge",
				body: { merge_method: "squash" },
			},
			{ method: "PUT", endpoint: "/repos/acme/shop/pulls/7/update-branch", body: {} },
		]);
		expect(mocks.execFileSync).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
	});

	it("refuses a PR number or merge method that is not one", async () => {
		const project = serverProject();
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			await expect(prDiff(project, bad)).rejects.toThrow("Invalid PR number");
		}
		await expect(
			prMerge(project, 7, "--admin" as unknown as "merge"),
		).rejects.toThrow("Invalid merge method");
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("keeps gh for a project of this computer", async () => {
		const local = { id: "l-1", path: "/work/shop" } as unknown as Project;
		mocks.execFileSync.mockReturnValue("diff");
		expect(await prDiff(local, 7)).toBe("diff");
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"gh",
			["pr", "diff", "7"],
			expect.objectContaining({ cwd: "/work/shop" }),
		);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});
});
