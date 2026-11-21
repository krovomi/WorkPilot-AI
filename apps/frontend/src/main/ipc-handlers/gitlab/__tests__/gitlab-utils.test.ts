/**
 * @vitest-environment node
 *
 * The GitLab config of a project (its `.workpilot/.env`, else glab's token),
 * the REST calls, and the host glab names an instance by.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	glab: new Map<string, string | Error>(),
	glabCalls: [] as { command: string; args: string[] }[],
	remotes: [] as { name: string; url: string }[],
}));

vi.mock("node:child_process", () => {
	const execFile = vi.fn(
		(
			command: string,
			args: string[],
			_options: unknown,
			callback: (error: Error | null, result?: { stdout: string }) => void,
		) => {
			state.glabCalls.push({ command, args });
			const answer = state.glab.get(args.join(" ")) ?? new Error("not logged in");
			if (answer instanceof Error) callback(answer);
			else callback(null, { stdout: answer });
		},
	);
	const module = { execFile };
	return { ...module, default: module };
});
vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => `/tools/${tool}`,
}));
vi.mock("../../../env-utils", () => ({ getAugmentedEnv: () => ({}) }));
vi.mock("../../../forge/project-forge-binding", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../forge/project-forge-binding")>()),
	listGitRemotes: () => state.remotes,
}));
vi.mock("../../../project-env-file", async () => {
	const fs = await import("node:fs");
	const nodePath = await import("node:path");
	return {
		getProjectEnvPath: (project: { path: string; autoBuildPath?: string }) =>
			project.autoBuildPath
				? nodePath.join(project.path, project.autoBuildPath, ".env")
				: null,
		readProjectEnvFileAsync: async (file: string) => {
			const text = fs.readFileSync(file, "utf-8");
			if (text === "unreadable") throw new Error("bad file");
			return Object.fromEntries(
				text
					.split("\n")
					.filter((line) => line.includes("="))
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			);
		},
	};
});

import type { Project } from "../../../../shared/types";
import { serverHandle } from "../../github/server-relay";
import {
	encodeProjectPath,
	getGitLabConfig,
	getGlabToken,
	gitlabFetch,
	gitlabFetchWithCount,
	glabHost,
	glabHostArgs,
	normalizeProjectReference,
} from "../utils";

let dir: string;

function projectWith(env: string | null, autoBuildPath = ".workpilot"): Project {
	if (env !== null) {
		mkdirSync(path.join(dir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(dir, ".workpilot", ".env"), env);
	}
	return { id: "p1", name: "shop", path: dir, autoBuildPath } as unknown as Project;
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "gitlab-utils-"));
	state.glab.clear();
	state.glabCalls = [];
	state.remotes = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the GitLab config of a project", () => {
	it("reads the token, instance and project of its .env", async () => {
		const project = projectWith(
			"GITLAB_TOKEN=pat-test-0000\nGITLAB_INSTANCE_URL=https://gitlab.acme.dev/\nGITLAB_PROJECT=acme/shop",
		);
		await expect(getGitLabConfig(project)).resolves.toEqual({
			token: "pat-test-0000",
			instanceUrl: "https://gitlab.acme.dev",
			project: "acme/shop",
		});
		expect(state.glabCalls).toEqual([]);
	});

	it("reduces a project set as a clone URL to its path", async () => {
		const project = projectWith(
			"GITLAB_TOKEN=pat-test-0000\nGITLAB_PROJECT=https://gitlab.com/acme/shop.git",
		);
		await expect(getGitLabConfig(project)).resolves.toMatchObject({
			instanceUrl: "https://gitlab.com",
			project: "acme/shop",
		});
	});

	it("takes glab's token for the instance when the .env has none", async () => {
		state.glab.set("auth token --hostname=gitlab.acme.dev:8443", "glpat-test-0000\n");
		const project = projectWith(
			"GITLAB_INSTANCE_URL=https://gitlab.acme.dev:8443\nGITLAB_PROJECT=7",
		);
		await expect(getGitLabConfig(project)).resolves.toEqual({
			token: "glpat-test-0000",
			instanceUrl: "https://gitlab.acme.dev:8443",
			project: "7",
		});
		expect(state.glabCalls[0].command).toBe("/tools/glab");
	});

	it("takes the project's own remote on the instance when no project is saved", async () => {
		state.remotes = [
			{ name: "origin", url: "git@github.com:acme/mirror.git" },
			{ name: "gl", url: "https://gitlab.acme.dev/team/shop.git" },
		];
		await expect(
			getGitLabConfig(
				projectWith("GITLAB_TOKEN=pat-test-0000\nGITLAB_INSTANCE_URL=https://gitlab.acme.dev"),
			),
		).resolves.toMatchObject({ project: "team/shop" });
		// A remote on another instance is not this project's GitLab project.
		await expect(
			getGitLabConfig(projectWith("GITLAB_TOKEN=pat-test-0000")),
		).resolves.toBeNull();
	});

	it("is null without a token anywhere, without a project, or turned off", async () => {
		await expect(getGitLabConfig(projectWith("GITLAB_PROJECT=acme/shop"))).resolves.toBeNull();
		await expect(getGitLabConfig(projectWith("GITLAB_TOKEN=pat-test-0000"))).resolves.toBeNull();
		await expect(
			getGitLabConfig(
				projectWith("GITLAB_ENABLED=False\nGITLAB_TOKEN=pat-test-0000\nGITLAB_PROJECT=a/b"),
			),
		).resolves.toBeNull();
	});

	it("is null for an instance URL that is not http(s), or carries credentials", async () => {
		for (const url of ["ftp://gitlab.acme.dev", "https://ada:pw@gitlab.acme.dev", "not a url"]) {
			await expect(
				getGitLabConfig(
					projectWith(`GITLAB_INSTANCE_URL=${url}\nGITLAB_TOKEN=pat-test-0000\nGITLAB_PROJECT=a/b`),
				),
			).resolves.toBeNull();
		}
	});

	it("drops control characters, caps the token and refuses an overlong project", async () => {
		const long = "t".repeat(600);
		const config = await getGitLabConfig(
			projectWith(`GITLAB_TOKEN=\u0001${long}\u007f\nGITLAB_PROJECT= a/b\u0002 `),
		);
		expect(config?.token).toHaveLength(512);
		expect(config?.project).toBe("a/b");

		await expect(
			getGitLabConfig(projectWith(`GITLAB_TOKEN=pat-test-0000\nGITLAB_PROJECT=${"a".repeat(1025)}`)),
		).resolves.toBeNull();
		await expect(
			getGitLabConfig(projectWith("GITLAB_TOKEN=\u0001 \nGITLAB_PROJECT=\u0002")),
		).resolves.toBeNull();
	});

	it("is null without a .env, with an unreadable one, or without a place for it", async () => {
		await expect(getGitLabConfig(projectWith(null))).resolves.toBeNull();
		await expect(getGitLabConfig(projectWith("unreadable"))).resolves.toBeNull();
		await expect(getGitLabConfig(projectWith(null, ""))).resolves.toBeNull();
	});

	it("is the server's for a server project", async () => {
		const project = {
			id: "s1",
			remote: { forge: "gitlab", repoUrl: "https://gitlab.acme.dev/acme/shop.git" },
		} as unknown as Project;
		await expect(getGitLabConfig(project)).resolves.toEqual({
			token: serverHandle("s1"),
			instanceUrl: "https://gitlab.acme.dev",
			project: "acme/shop",
		});
	});
});

describe("the host glab names an instance by", () => {
	it("is gitlab.com by default, the host of a URL, or the host as sent", () => {
		expect(glabHost(undefined)).toBe("gitlab.com");
		expect(glabHost("")).toBe("gitlab.com");
		expect(glabHost("GitLab.Acme.dev")).toBe("gitlab.acme.dev");
		expect(glabHost("http://gitlab.acme.dev:8080/root")).toBe("gitlab.acme.dev:8080");
	});

	it("is null for what is not one", () => {
		expect(glabHost(null)).toBeNull();
		expect(glabHost("ssh://gitlab.acme.dev")).toBeNull();
		expect(glabHost("ada@gitlab.acme.dev")).toBeNull();
		expect(glabHost("-x.dev")).toBeNull();
	});

	it("is passed as one --hostname argument, none for gitlab.com", () => {
		expect(glabHostArgs("gitlab.com")).toEqual([]);
		expect(glabHostArgs("gitlab.acme.dev")).toEqual(["--hostname=gitlab.acme.dev"]);
	});

	it("gives glab's token, null when glab has none", async () => {
		state.glab.set("auth token", "glpat-test-0000");
		await expect(getGlabToken("gitlab.com")).resolves.toBe("glpat-test-0000");
		await expect(getGlabToken("gitlab.acme.dev")).resolves.toBeNull();
	});
});

describe("project references", () => {
	it("are reduced to a path, whatever URL form they come in", () => {
		expect(normalizeProjectReference("")).toBe("");
		expect(normalizeProjectReference("42")).toBe("42");
		expect(normalizeProjectReference("https://gitlab.com/a/b.git")).toBe("a/b");
		expect(normalizeProjectReference("git@gitlab.acme.dev:a/b.git", "https://gitlab.acme.dev")).toBe("a/b");
		expect(normalizeProjectReference(" a/b ", "not a url")).toBe("a/b");
	});

	it("are encoded for the API, a numeric id as it is", () => {
		expect(encodeProjectPath("42")).toBe("42");
		expect(encodeProjectPath("a/b c")).toBe("a%2Fb%20c");
	});
});

describe("REST calls", () => {
	function stubFetch(response: Partial<Omit<Response, "body">> & { body?: unknown }) {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			json: async () => response.body,
			text: async () => "",
			...response,
		}));
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("send the token in its header to the instance's API", async () => {
		const fetchMock = stubFetch({ body: { id: 1 } });
		await expect(
			gitlabFetch("pat-test-0000", "https://gitlab.acme.dev/", "/projects/1", {
				headers: { Accept: "x" },
			}),
		).resolves.toEqual({ id: 1 });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://gitlab.acme.dev/api/v4/projects/1");
		expect(init.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "x",
			"PRIVATE-TOKEN": "pat-test-0000",
		});
	});

	it("give the total count of a paginated endpoint, 0 without a number", async () => {
		stubFetch({ body: [1], headers: new Headers({ "X-Total": "37" }) });
		await expect(gitlabFetchWithCount("pat-test-0000", "https://gitlab.com", "/x")).resolves.toEqual({
			data: [1],
			totalCount: 37,
		});
		stubFetch({ body: [], headers: new Headers({ "X-Total": "many" }) });
		await expect(gitlabFetchWithCount("pat-test-0000", "https://gitlab.com", "/x")).resolves.toEqual({
			data: [],
			totalCount: 0,
		});
		stubFetch({ body: [] });
		await expect(gitlabFetchWithCount("pat-test-0000", "https://gitlab.com", "/x")).resolves.toMatchObject({
			totalCount: 0,
		});
	});

	it("stay on the instance, and are refused before any request for a bad instance, endpoint or token", async () => {
		const fetchMock = stubFetch({ body: null });
		await expect(gitlabFetch("t", "file:///etc", "/x")).rejects.toThrow("Invalid GitLab instance URL");
		await expect(gitlabFetch("t", " ", "/x")).rejects.toThrow("Invalid GitLab instance URL");
		await expect(gitlabFetch("t", "https://gitlab.com", "//evil.dev/x")).resolves.toBeNull();
		await expect(gitlabFetch("t", "https://gitlab.com", "x")).rejects.toThrow(
			"GitLab endpoint must be a relative path",
		);
		await expect(gitlabFetchWithCount("\u0001", "https://gitlab.com", "/x")).rejects.toThrow(
			"Invalid GitLab token",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://gitlab.com/api/v4//evil.dev/x");
	});

	it("say what GitLab answered on an error", async () => {
		stubFetch({ ok: false, status: 404, statusText: "Not Found", text: async () => "no project" });
		await expect(gitlabFetch("t", "https://gitlab.com", "/x")).rejects.toThrow(
			"GitLab API error: 404 Not Found - no project",
		);
	});

	it("stop after 30 seconds", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => {
							const error = new Error("aborted");
							error.name = "AbortError";
							reject(error);
						});
					}),
			),
		);
		const pending = gitlabFetch("t", "https://gitlab.com", "/slow");
		const check = expect(pending).rejects.toThrow(
			"GitLab API timeout after 30s: https://gitlab.com/api/v4/slow",
		);
		await vi.advanceTimersByTimeAsync(30_000);
		await check;
	});

	it("rethrow a network error as it is", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject("offline")));
		await expect(gitlabFetch("t", "https://gitlab.com", "/x")).rejects.toBe("offline");
	});

	it("of a server project go through the server", async () => {
		const relay = await import("../server-relay");
		const spy = vi.spyOn(relay, "relayGitLabFetch").mockResolvedValue({ via: "server" });
		const countSpy = vi
			.spyOn(relay, "relayGitLabFetchWithCount")
			.mockResolvedValue({ data: [], totalCount: 3 });
		const handle = serverHandle("s1");
		await expect(gitlabFetch(handle, "https://gitlab.com", "/x")).resolves.toEqual({ via: "server" });
		await expect(gitlabFetchWithCount(handle, "https://gitlab.com", "/x")).resolves.toEqual({
			data: [],
			totalCount: 3,
		});
		expect(spy).toHaveBeenCalledWith(handle, "/x", {});
		expect(countSpy).toHaveBeenCalledWith(handle, "/x", {});
	});
});
