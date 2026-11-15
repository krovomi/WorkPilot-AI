/**
 * @vitest-environment node
 *
 * Where a local project's GitHub access comes from (its `.workpilot/.env`,
 * else the gh CLI), how a repository reference becomes `owner/repo`, which
 * references may become an API path, and the API call itself: headers, an
 * error that carries GitHub's answer, a server project relayed instead.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	ghToken: null as string | null,
	ghCalls: [] as string[][],
	relay: vi.fn(async () => ({ relayed: true })),
	serverConfig: vi.fn(() => ({ token: "server:p", repo: "acme/shop" })),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const answer = (args: string[]) => {
		// Only `gh auth token` is the stand-in's to answer; the environment
		// setup may ask other tools, which find nothing here.
		if (args[0] !== "auth") throw new Error("not available in this test");
		state.ghCalls.push(args);
		if (state.ghToken === null) throw new Error("gh: not logged in");
		return `${state.ghToken}\n`;
	};
	return {
		...actual,
		execFileSync: (_cmd: string, args: string[]) => answer(args),
		execFile: (
			_cmd: string,
			args: string[],
			_opts: unknown,
			cb: (err: Error | null, out?: { stdout: string }) => void,
		) => {
			try {
				cb(null, { stdout: answer(args) });
			} catch (error) {
				cb(error as Error);
			}
		},
	};
});
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));
vi.mock("../server-relay", () => ({
	isServerHandle: (token: string) => token.startsWith("server:"),
	relayGitHubFetch: state.relay,
	serverGitHubConfig: state.serverConfig,
}));

import type { Project } from "../../../../shared/types";
import {
	getGitHubConfig,
	getGitHubTokenForSubprocess,
	githubFetch,
	isRepoFullName,
	normalizeRepoReference,
} from "../utils";

let root: string;
let project: Project;
const fetchMock = vi.fn();

const writeEnv = (content: string) => {
	mkdirSync(path.join(root, ".workpilot"), { recursive: true });
	writeFileSync(path.join(root, ".workpilot", ".env"), content);
};

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-utils-"));
	project = { id: "p", name: "P", path: root, autoBuildPath: ".workpilot" } as Project;
	state.ghToken = null;
	state.ghCalls = [];
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

describe("getGitHubConfig", () => {
	it("reads the token and the repository from the project's .env", () => {
		writeEnv("GITHUB_TOKEN=pat-test-0000\nGITHUB_REPO=acme/shop\n");

		expect(getGitHubConfig(project)).toEqual({ token: "pat-test-0000", repo: "acme/shop" });
		expect(state.ghCalls).toEqual([]);
	});

	it("falls back to the gh CLI token when the .env has none", () => {
		writeEnv("GITHUB_REPO=acme/shop\n");
		state.ghToken = "gho-test-0000";

		expect(getGitHubConfig(project)).toEqual({ token: "gho-test-0000", repo: "acme/shop" });
		expect(state.ghCalls).toEqual([["auth", "token"]]);
	});

	it("has no configuration without a token, a repository or a .env", () => {
		expect(getGitHubConfig(project)).toBeNull();
		expect(getGitHubConfig({ ...project, autoBuildPath: "" } as Project)).toBeNull();

		writeEnv("GITHUB_REPO=acme/shop\n");
		expect(getGitHubConfig(project)).toBeNull();

		state.ghToken = "";
		expect(getGitHubConfig(project)).toBeNull();

		writeEnv("GITHUB_TOKEN=pat-test-0000\n");
		expect(getGitHubConfig(project)).toBeNull();
	});

	it("asks the server for a server project", () => {
		const remote = { ...project, remote: { serverUrl: "https://s.invalid" } } as unknown as Project;

		expect(getGitHubConfig(remote)).toEqual({ token: "server:p", repo: "acme/shop" });
		expect(state.serverConfig).toHaveBeenCalledWith(remote);
	});
});

describe("getGitHubTokenForSubprocess", () => {
	it("asks gh each time, and answers null when it cannot", async () => {
		state.ghToken = "gho-test-0000";
		await expect(getGitHubTokenForSubprocess()).resolves.toBe("gho-test-0000");

		state.ghToken = "";
		await expect(getGitHubTokenForSubprocess()).resolves.toBeNull();

		state.ghToken = null;
		await expect(getGitHubTokenForSubprocess()).resolves.toBeNull();
		expect(state.ghCalls).toHaveLength(3);
	});
});

describe("normalizeRepoReference and isRepoFullName", () => {
	it.each([
		["acme/shop", "acme/shop"],
		["https://github.com/acme/shop", "acme/shop"],
		["https://github.com/acme/shop.git", "acme/shop"],
		["http://github.com/acme/shop", "acme/shop"],
		["git@github.com:acme/shop.git", "acme/shop"],
		["  acme/shop  ", "acme/shop"],
		["", ""],
	])("reads %j as %j", (reference, expected) => {
		expect(normalizeRepoReference(reference)).toBe(expected);
	});

	it.each([["acme/shop"], ["a-b/c.d_e-f"], ["A1/x"]])("accepts %j as a repository", (name) => {
		expect(isRepoFullName(name)).toBe(true);
	});

	it.each([
		["acme"],
		["acme/shop/issues"],
		["acme/.."],
		["acme/."],
		["../acme/shop"],
		["acme/shop?per_page=1"],
		["acme/shop#x"],
		["acme /shop"],
		[""],
	])("refuses %j, which would not stay one repository in an API path", (name) => {
		expect(isRepoFullName(name)).toBe(false);
	});
});

describe("githubFetch", () => {
	it("calls the API with the token and GitHub's headers", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));

		await expect(githubFetch("pat-test-0000", "/repos/acme/shop", { method: "GET", headers: { "X-Extra": "1" } })).resolves.toEqual({ ok: 1 });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.github.com/repos/acme/shop");
		expect(init.method).toBe("GET");
		expect(init.headers).toEqual({
			Accept: "application/vnd.github+json",
			Authorization: "Bearer pat-test-0000",
			"User-Agent": "WorkPilot-AI",
			"X-Extra": "1",
		});
	});

	it("keeps an absolute URL as it is", async () => {
		fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

		await githubFetch("pat-test-0000", "https://api.github.com/user/repos?page=2");

		expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/user/repos?page=2");
	});

	it("throws GitHub's answer when the call fails", async () => {
		fetchMock.mockResolvedValue(
			new Response("Bad credentials", { status: 401, statusText: "Unauthorized" }),
		);

		await expect(githubFetch("pat-test-0000", "/user")).rejects.toThrow(
			"GitHub API error: 401 Unauthorized - Bad credentials",
		);
	});

	it("relays a server project's call instead of reaching GitHub", async () => {
		await expect(githubFetch("server:p", "/repos/acme/shop", { method: "POST" })).resolves.toEqual({
			relayed: true,
		});
		expect(state.relay).toHaveBeenCalledWith("server:p", "/repos/acme/shop", { method: "POST" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
