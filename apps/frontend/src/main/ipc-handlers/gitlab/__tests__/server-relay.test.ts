/**
 * GitLab for a server project: every call goes to the server, by project id,
 * and is made there with the person's own token, on an instance the server's
 * operator named. Nothing is sent to GitLab from this computer, and an issue
 * becomes a card of the project's shared board.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const handlers = vi.hoisted(() => new Map<string, Function>());
const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	createServerCard: vi.fn(),
	createSpecForIssue: vi.fn(),
	fetch: vi.fn(),
	project: undefined as unknown,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Function) => handlers.set(channel, handler),
	},
}));
vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../../server-board-actions", () => ({
	createServerCard: mocks.createServerCard,
}));
vi.mock("../../server-feature-files", () => ({
	featureProject: (id: unknown) => (id === "p-1" ? mocks.project : undefined),
}));
vi.mock("../../shared/issue-attachments", () => ({
	attachGitLabIssueImages: vi.fn(),
}));
vi.mock("../spec-utils", async (actual) => ({
	...(await actual<typeof import("../spec-utils")>()),
	createSpecForIssue: mocks.createSpecForIssue,
}));

import { isServerHandle, serverGitHubConfig } from "../../github/server-relay";
import { registerImportIssues } from "../import-handlers";
import { gitlabProjectOf, serverGitLabConfig } from "../server-relay";
import { getGitLabConfig, gitlabFetch, gitlabFetchWithCount } from "../utils";

function serverProject(
	repoUrl = "https://git.acme.test/team/web/shop.git",
	forge: "github" | "gitlab" | null = "gitlab",
): Project {
	return {
		id: "p-1",
		path: "/nowhere/mirror",
		remote: { repoUrl, defaultBranch: "main", role: "member", forge },
	} as unknown as Project;
}

function answered(answer: unknown) {
	mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: answer });
}

function importIssues(...args: unknown[]) {
	const handler = handlers.get(IPC_CHANNELS.GITLAB_IMPORT_ISSUES);
	if (!handler) throw new Error("handler not registered");
	return handler({}, ...args);
}

beforeEach(() => {
	handlers.clear();
	for (const mock of [
		mocks.authedFetch,
		mocks.createServerCard,
		mocks.createSpecForIssue,
		mocks.fetch,
	]) {
		mock.mockReset();
	}
	mocks.project = serverProject();
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("a server project's GitLab", () => {
	it("is the project the server cloned, and its token is a handle", async () => {
		expect(gitlabProjectOf("https://git.acme.test/team/web/shop.git")).toEqual({
			instanceUrl: "https://git.acme.test",
			project: "team/web/shop",
		});
		expect(gitlabProjectOf("git@gitlab.com:acme/shop.git")).toEqual({
			instanceUrl: "https://gitlab.com",
			project: "acme/shop",
		});
		expect(gitlabProjectOf("https://gitlab.com/acme/../shop")).toBeNull();
		expect(gitlabProjectOf("https://gitlab.com/shop")).toBeNull();

		const config = await getGitLabConfig(serverProject());
		expect(config).toEqual(serverGitLabConfig(serverProject()));
		expect(config?.project).toBe("team/web/shop");
		expect(isServerHandle(config?.token ?? "")).toBe(true);
		// Only the forge the server lists: a GitLab host it did not name is none.
		expect(serverGitLabConfig(serverProject(undefined, null))).toBeNull();
		expect(serverGitLabConfig(serverProject(undefined, "github"))).toBeNull();
		expect(serverGitHubConfig(serverProject())).toBeNull();
	});

	it("reads through the server's read route, by project id", async () => {
		const config = await getGitLabConfig(serverProject());
		answered({ status: 200, body: [{ iid: 4 }], total: 42 });
		const endpoint = "/projects/team%2Fweb%2Fshop/issues?state=opened&per_page=1";
		const page = await gitlabFetchWithCount(
			config?.token ?? "",
			config?.instanceUrl ?? "",
			endpoint,
		);
		expect(page).toEqual({ data: [{ iid: 4 }], totalCount: 42 });
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/gitlab/read?project_id=p-1",
			"POST",
			{ method: "GET", endpoint },
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("changes through the write route, and shows the server's refusal", async () => {
		const config = await getGitLabConfig(serverProject());
		answered({ status: 200, body: { id: 1 } });
		await gitlabFetch(
			config?.token ?? "",
			config?.instanceUrl ?? "",
			"/projects/team%2Fweb%2Fshop/merge_requests/7/merge",
			{ method: "PUT", body: JSON.stringify({ squash: true }) },
		);
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/gitlab/write?project_id=p-1",
			"POST",
			{
				method: "PUT",
				endpoint: "/projects/team%2Fweb%2Fshop/merge_requests/7/merge",
				body: { squash: true },
			},
		);

		mocks.authedFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			error: "Missing permission: vcs.pr.merge",
		});
		await expect(
			gitlabFetch(config?.token ?? "", "", "/projects/team%2Fweb%2Fshop/merge_requests/7/merge", {
				method: "PUT",
			}),
		).rejects.toThrow(/vcs\.pr\.merge/);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("makes an issue a card of the shared board, with no spec here", async () => {
		registerImportIssues();
		answered({
			status: 200,
			body: {
				iid: 12,
				title: "Login loops",
				description: "Steps to reproduce",
				state: "opened",
				labels: ["bug"],
				assignees: [],
				created_at: "2026-10-30T10:00:00Z",
				web_url: "https://git.acme.test/team/web/shop/-/issues/12",
			},
		});
		const card = { id: "server:p-1:c-9", title: "Login loops" };
		mocks.createServerCard.mockResolvedValueOnce({ success: true, data: card });

		const result = await importIssues("p-1", [12]);

		expect(result.data).toMatchObject({ success: true, imported: 1, tasks: [card] });
		const [, title, description] = mocks.createServerCard.mock.calls[0];
		expect(title).toBe("Login loops");
		expect(description).toContain("GitLab Issue #12");
		expect(description).toContain("Steps to reproduce");
		expect(mocks.createSpecForIssue).not.toHaveBeenCalled();
	});

	it("refuses an issue number that is not one before any call", async () => {
		registerImportIssues();
		const result = await importIssues("p-1", ["12/../../user", -1]);
		expect(result.data).toMatchObject({ imported: 0, failed: 2 });
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		expect(mocks.createServerCard).not.toHaveBeenCalled();
	});
});
