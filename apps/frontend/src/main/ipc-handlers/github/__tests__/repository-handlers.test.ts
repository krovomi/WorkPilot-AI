/**
 * @vitest-environment node
 *
 * The connection check, the repository list and the connection test of the
 * settings modal, against a stand-in GitHub (fetch). A repository reference
 * that is not one `owner/repo` never becomes an API path, and the test
 * connection checks what the renderer sends before using it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	project: undefined as unknown,
	config: null as { token: string; repo: string } | null,
}));

vi.mock("../../../project-store", () => ({ projectStore: { getProject: () => state.project } }));
vi.mock("../../server-feature-files", () => ({ featureProject: () => state.project }));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getGitHubConfig: () => state.config,
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerRepositoryHandlers } from "../repository-handlers";

type Result = { success: boolean; error?: string; status?: number; data?: Record<string, unknown> | unknown[] };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const fetchMock = vi.fn();
const json = (body: unknown, status = 200, statusText = "") =>
	new Response(JSON.stringify(body), { status, statusText });

registerRepositoryHandlers();

beforeEach(() => {
	state.project = { id: "p", path: "/repo" };
	state.config = { token: "pat-test-0000", repo: "https://github.com/acme/shop.git" };
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GITHUB_CHECK_CONNECTION", () => {
	it("reads the repository and counts its open issues from the search total", async () => {
		fetchMock
			.mockResolvedValueOnce(json({ full_name: "acme/shop", description: "Shop" }))
			.mockResolvedValueOnce(json({ total_count: 37, items: [{}] }));

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "p");

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			connected: true,
			repoFullName: "acme/shop",
			repoDescription: "Shop",
			issueCount: 37,
		});
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/shop");
		expect(fetchMock.mock.calls[1][0]).toBe(
			`https://api.github.com/search/issues?q=${encodeURIComponent("repo:acme/shop is:issue is:open")}&per_page=1`,
		);
	});

	it("counts 0 when the search answers no total", async () => {
		fetchMock.mockResolvedValueOnce(json({ full_name: "acme/shop" })).mockResolvedValueOnce(json({}));

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "p");

		expect(result.data).toMatchObject({ connected: true, issueCount: 0 });
	});

	it("answers an unknown project, and a project without configuration", async () => {
		state.project = undefined;
		expect(await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "nope")).toEqual({
			success: false,
			error: "Project not found",
		});

		state.project = { id: "p" };
		state.config = null;
		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "p");
		expect(result.data).toEqual({ connected: false, error: "No GitHub token or repository configured" });
	});

	it.each([["acme"], ["acme/shop/../../user"], ["acme/shop?x=1"]])(
		"does not call GitHub for the reference %j",
		async (repo) => {
			state.config = { token: "pat-test-0000", repo };

			const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "p");

			expect(result.data).toMatchObject({ connected: false, error: expect.stringMatching(/^Invalid repository format/) });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		[new Error("network down"), "network down"],
		["odd", "Failed to connect to GitHub"],
	])("reports a failed call as not connected: %s", async (thrown, message) => {
		fetchMock.mockRejectedValue(thrown);

		const result = await invoke(IPC_CHANNELS.GITHUB_CHECK_CONNECTION, "p");

		expect(result).toEqual({ success: true, data: { connected: false, error: message } });
	});
});

describe("GITHUB_GET_REPOSITORIES", () => {
	it("maps the repositories the token reaches", async () => {
		fetchMock.mockResolvedValue(
			json([
				{
					id: 1,
					name: "shop",
					full_name: "acme/shop",
					description: null,
					html_url: "https://github.com/acme/shop",
					default_branch: "main",
					private: true,
					owner: { login: "acme", avatar_url: "https://avatars.invalid/acme" },
				},
			]),
		);

		const result = await invoke(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, "p");

		expect(result).toEqual({
			success: true,
			data: [
				{
					id: 1,
					name: "shop",
					fullName: "acme/shop",
					description: null,
					url: "https://github.com/acme/shop",
					defaultBranch: "main",
					private: true,
					owner: { login: "acme", avatarUrl: "https://avatars.invalid/acme" },
				},
			],
		});
		expect(String(fetchMock.mock.calls[0][0])).toContain("/user/repos?per_page=100");
	});

	it("answers an unknown project, a missing token and a failed call", async () => {
		state.project = undefined;
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, "nope")).error).toBe("Project not found");

		state.project = { id: "p" };
		state.config = null;
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, "p")).error).toBe("No GitHub token configured");

		state.config = { token: "pat-test-0000", repo: "acme/shop" };
		fetchMock.mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, "p")).error).toMatch(/^GitHub API error: 500/);

		fetchMock.mockRejectedValue(42);
		expect((await invoke(IPC_CHANNELS.GITHUB_GET_REPOSITORIES, "p")).error).toBe("Failed to fetch repositories");
	});
});

describe("GITHUB_TEST_CONNECTION", () => {
	it("succeeds when GitHub knows the repository for this token", async () => {
		fetchMock.mockResolvedValue(json({}));

		const result = await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, {
			repo: "git@github.com:acme/shop.git",
			token: "pat-test-0000",
		});

		expect(result).toEqual({ success: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.github.com/repos/acme/shop");
		expect(init.headers.Authorization).toBe("token pat-test-0000");
	});

	it("gives the status of a refusal, for the modal to explain it", async () => {
		fetchMock.mockResolvedValueOnce(new Response("", { status: 404, statusText: "Not Found" }));
		expect(await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, { repo: "acme/shop", token: "t" })).toEqual({
			success: false,
			status: 404,
			error: "Not Found",
		});

		fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
		expect(await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, { repo: "acme/shop", token: "t" })).toEqual({
			success: false,
			status: 403,
			error: "Connection failed",
		});
	});

	it.each([
		[undefined],
		[null],
		["acme/shop"],
		[{ repo: "acme/shop" }],
		[{ repo: "", token: "t" }],
		[{ repo: ["acme/shop"], token: "t" }],
		[{ repo: "acme/shop", token: 42 }],
	])("refuses what the renderer sent: %j", async (config) => {
		const result = await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, config);

		expect(result).toEqual({ success: false, error: "Repository and token are required" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not call GitHub for a reference that is not one repository", async () => {
		const result = await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, {
			repo: "acme/shop/../../user",
			token: "t",
		});

		expect(result.error).toMatch(/^Invalid repository format/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[new Error("ECONNRESET"), "ECONNRESET"],
		[undefined, "Network error during connection test"],
	])("reports a network failure: %s", async (thrown, message) => {
		fetchMock.mockRejectedValue(thrown);

		expect(await invoke(IPC_CHANNELS.GITHUB_TEST_CONNECTION, { repo: "acme/shop", token: "t" })).toEqual({
			success: false,
			error: message,
		});
	});
});
