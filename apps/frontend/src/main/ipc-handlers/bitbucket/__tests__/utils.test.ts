/**
 * @vitest-environment node
 *
 * The Bitbucket config and REST calls: a request, a pagination `next` link
 * or a redirect only ever reaches https://api.bitbucket.org/2.0, the token
 * only in its Authorization header; a project with Bitbucket off,
 * incomplete or on a server has no config.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import {
	authorizationHeader,
	BitbucketApiError,
	bitbucketConfigFromEnv,
	bitbucketFetch,
	bitbucketFetchAll,
	getBitbucketConfig,
	isBitbucketApiUrl,
	isPipelineUuid,
	repoPath,
} from "../utils";

const CONFIG = { workspace: "acme", repo: "web", username: "dev@example.com", token: "bb-test-0000" };
const ENV = {
	BITBUCKET_ENABLED: "true",
	BITBUCKET_WORKSPACE: "acme",
	BITBUCKET_REPO: "web",
	BITBUCKET_TOKEN: "bb-test-0000",
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answers: Array<() => Response>;

/** The error a call rejects with. */
const failure = (call: Promise<unknown>) =>
	call.then(
		() => {
			throw new Error("resolved");
		},
		(error: BitbucketApiError) => error,
	);
const json = (body: unknown, status = 200) => () =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
	calls = [];
	answers = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			const next = answers.shift();
			if (!next) throw new Error("no answer");
			return next();
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("bitbucketConfigFromEnv", () => {
	it("reads the repository, the token and the optional username", () => {
		expect(bitbucketConfigFromEnv(ENV)).toEqual({ workspace: "acme", repo: "web", token: "bb-test-0000" });
		expect(
			bitbucketConfigFromEnv({ ...ENV, BITBUCKET_REPO: "git@bitbucket.org:team/api.git", BITBUCKET_USERNAME: " dev " }),
		).toEqual({ workspace: "team", repo: "api", token: "bb-test-0000", username: "dev" });
	});

	it("has none when disabled, without token, with a hostile repository or token", () => {
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_ENABLED: "false" })).toBeNull();
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_TOKEN: "" })).toBeNull();
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_TOKEN: "\u0001\u0002" })).toBeNull();
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_TOKEN: "x".repeat(2000) })).toBeNull();
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_REPO: "../../etc" })).toBeNull();
		expect(bitbucketConfigFromEnv({ ...ENV, BITBUCKET_REPO: "https://evil.example/acme/web" })).toBeNull();
	});
});

describe("getBitbucketConfig", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "bb-config-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const project = (extra: Partial<Project> = {}) =>
		({ id: "p1", path: dir, autoBuildPath: ".workpilot", ...extra }) as Project;

	it("reads the project's .workpilot/.env", async () => {
		mkdirSync(path.join(dir, ".workpilot"));
		writeFileSync(
			path.join(dir, ".workpilot", ".env"),
			Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join("\n"),
		);
		expect(await getBitbucketConfig(project())).toMatchObject({ workspace: "acme", repo: "web" });
	});

	it("has none for a server project or one not initialized", async () => {
		expect(await getBitbucketConfig(project({ remote: { repoUrl: "", defaultBranch: "main", role: "owner" } }))).toBeNull();
		expect(await getBitbucketConfig(project({ autoBuildPath: "" }))).toBeNull();
		expect(await getBitbucketConfig(project())).toBeNull();
	});
});

describe("auth and paths", () => {
	it("uses Basic with a username, Bearer without", () => {
		expect(authorizationHeader(CONFIG)).toBe(
			`Basic ${Buffer.from("dev@example.com:bb-test-0000").toString("base64")}`,
		);
		expect(authorizationHeader({ token: "bb-test-0000" })).toBe("Bearer bb-test-0000");
	});

	it("encodes the repository path and recognizes a pipeline uuid", () => {
		expect(repoPath(CONFIG)).toBe("/repositories/acme/web");
		expect(isPipelineUuid("{12345678-1234-1234-1234-123456789abc}")).toBe(true);
		for (const bad of ["12345678-1234-1234-1234-123456789abc", "{../../x}", "", 3]) {
			expect(isPipelineUuid(bad)).toBe(false);
		}
	});

	it("keeps only https URLs of the API host", () => {
		expect(isBitbucketApiUrl("https://api.bitbucket.org/2.0/repositories?page=2")).toBe(true);
		for (const bad of [
			"http://api.bitbucket.org/2.0/x",
			"https://api.bitbucket.org.evil.example/2.0/x",
			"https://evil.example/2.0/x",
			"https://user:pw@api.bitbucket.org/2.0/x",
			"https://api.bitbucket.org:8443/2.0/x",
			"https://api.bitbucket.org/1.0/x",
			"not a url",
			42,
		]) {
			expect(isBitbucketApiUrl(bad)).toBe(false);
		}
	});
});

describe("bitbucketFetch", () => {
	it("calls the API with the token in its header only", async () => {
		answers.push(json({ ok: true }));
		await expect(bitbucketFetch(CONFIG, "/repositories/acme/web")).resolves.toEqual({ ok: true });
		expect(calls[0].url).toBe("https://api.bitbucket.org/2.0/repositories/acme/web");
		expect(calls[0].url).not.toContain("bb-test-0000");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toMatch(/^Basic /);
		expect(calls[0].init.redirect).toBe("manual");
	});

	it("posts JSON and reads text", async () => {
		answers.push(() => new Response("diff --git"));
		await expect(bitbucketFetch(CONFIG, "/x", { method: "POST", body: { a: 1 }, as: "text" })).resolves.toBe(
			"diff --git",
		);
		expect(calls[0].init.body).toBe('{"a":1}');
		expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
	});

	it("refuses a path or URL off the API host before any request", async () => {
		for (const target of ["//evil.example/x", "https://evil.example/2.0/x", "relative/path"]) {
			await expect(bitbucketFetch(CONFIG, target)).rejects.toThrow("outside api.bitbucket.org");
		}
		expect(calls).toHaveLength(0);
	});

	it("follows a redirect on the API host and refuses one elsewhere", async () => {
		const redirect = (location: string) => () =>
			new Response(null, { status: 302, headers: { location } });
		answers.push(redirect("/2.0/repositories/acme/web/diff/a..b"), () => new Response("diff"));
		await expect(bitbucketFetch(CONFIG, "/x", { as: "text" })).resolves.toBe("diff");
		expect(calls[1].url).toBe("https://api.bitbucket.org/2.0/repositories/acme/web/diff/a..b");

		calls = [];
		answers.push(redirect("https://evil.example/steal"));
		await expect(bitbucketFetch(CONFIG, "/x")).rejects.toThrow("redirect outside");
		expect(calls).toHaveLength(1);

		answers.push(redirect("/2.0/a"), redirect("/2.0/b"), redirect("/2.0/c"));
		await expect(bitbucketFetch(CONFIG, "/x")).rejects.toThrow("redirect outside");
	});

	it("says the status and Bitbucket's message, bounded, on an error", async () => {
		answers.push(json({ error: { message: "Repository not found" } }, 404));
		const error = await failure(bitbucketFetch(CONFIG, "/x"));
		expect(error).toBeInstanceOf(BitbucketApiError);
		expect(error.status).toBe(404);
		expect(error.message).toBe("Bitbucket API error 404: Repository not found");

		answers.push(json({ error: { message: "m".repeat(1000) } }, 400));
		expect((await failure(bitbucketFetch(CONFIG, "/x"))).message.length).toBeLessThan(400);

		answers.push(() => new Response("<html>", { status: 500, statusText: "Server Error" }));
		expect((await failure(bitbucketFetch(CONFIG, "/x"))).message).toBe(
			"Bitbucket API error 500: Server Error",
		);
	});

	it("names a network failure and a timeout without details", async () => {
		answers.push(() => {
			throw new TypeError("fetch failed bb-test-0000");
		});
		const error = await failure(bitbucketFetch(CONFIG, "/x"));
		expect(error.message).toBe("Bitbucket API unreachable");
		expect(error.status).toBe(0);

		answers.push(() => {
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		});
		expect((await failure(bitbucketFetch(CONFIG, "/x"))).message).toBe("Bitbucket API timeout");
	});

	it("aborts a request that takes too long", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						);
					}),
			),
		);
		const pending = failure(bitbucketFetch(CONFIG, "/x"));
		await vi.advanceTimersByTimeAsync(31_000);
		expect((await pending).message).toBe("Bitbucket API timeout");
	});
});

describe("bitbucketFetchAll", () => {
	it("follows next links on the API host, up to the page limit", async () => {
		answers.push(
			json({ values: [1, 2], next: "https://api.bitbucket.org/2.0/x?page=2" }),
			json({ values: [3], next: "https://api.bitbucket.org/2.0/x?page=3" }),
		);
		await expect(bitbucketFetchAll(CONFIG, "/x", 2)).resolves.toEqual([1, 2, 3]);
		expect(calls).toHaveLength(2);
	});

	it("stops at a next link off the API host, and reads a page without values as empty", async () => {
		answers.push(json({ values: [1], next: "https://evil.example/2.0/x?page=2" }));
		await expect(bitbucketFetchAll(CONFIG, "/x")).resolves.toEqual([1]);
		answers.push(json({}));
		await expect(bitbucketFetchAll(CONFIG, "/x")).resolves.toEqual([]);
		expect(calls).toHaveLength(2);
	});
});
