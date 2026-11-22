/**
 * @vitest-environment node
 *
 * The Bitbucket handlers as the renderer reaches them, on a stand-in
 * api.bitbucket.org: the connection check, issues (and a repository whose
 * tracker is off), their comments and the import as tasks, pull requests,
 * their diff and comments, pipelines and their steps. Arguments of the wrong
 * shape never reach a handler, and no answer carries the token.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: {} as Record<string, Record<string, unknown>>,
	config: null as null | Record<string, string>,
	routes: [] as Array<[RegExp, (url: string) => Response]>,
	urls: [] as string[],
}));

vi.mock("../../../project-store", () => ({
	projectStore: { getProject: (id: string) => state.projects[id] },
}));
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	getBitbucketConfig: async () => state.config,
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerBitbucketHandlers } from "../index";
import { bitbucketArgsAllowed } from "../ipc-guard";
import { issueQuery } from "../issue-handlers";
import { errorMessage, withBitbucketProject } from "../project-bitbucket";

type MockIpc = typeof ipcMain & {
	invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};
const invoke = (channel: string, ...args: unknown[]) =>
	(ipcMain as MockIpc).invokeHandler(channel, {}, ...args) as Promise<{
		success: boolean;
		/** The answer as the view reads it, loosely typed for the assertions. */
		data?: ReturnType<typeof JSON.parse>;
		error?: string;
	}>;

const CONFIG = { workspace: "acme", repo: "web", token: "bb-test-0000" };
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const route = (pattern: RegExp, answer: (url: string) => Response) => state.routes.push([pattern, answer]);

const apiIssue = (id: number, extra: Record<string, unknown> = {}) => ({
	id,
	title: `Issue ${id}`,
	content: { raw: `Body of ${id}` },
	state: "open",
	kind: "bug",
	priority: "major",
	reporter: { display_name: "Ada", nickname: "ada" },
	created_on: "2026-11-01T10:00:00Z",
	updated_on: "2026-11-02T10:00:00Z",
	links: { html: { href: `https://bitbucket.org/acme/web/issues/${id}` } },
	...extra,
});

let dir: string;

beforeAll(() => registerBitbucketHandlers());

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "bb-handlers-"));
	state.projects = { p1: { id: "p1", path: dir, autoBuildPath: ".workpilot", settings: { mainBranch: "develop" } } };
	state.config = { ...CONFIG };
	state.routes = [];
	state.urls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			state.urls.push(url);
			const hit = state.routes.find(([pattern]) => pattern.test(url));
			return hit ? hit[1](url) : json({ error: { message: "not found" } }, 404);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("connection", () => {
	it("names the repository and whether its issue tracker is on", async () => {
		route(/\/repositories\/acme\/web$/, () =>
			json({
				full_name: "acme/web",
				description: "The site",
				has_issues: true,
				links: { html: { href: "https://bitbucket.org/acme/web" } },
			}),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, "p1");
		expect(result).toEqual({
			success: true,
			data: {
				connected: true,
				workspace: "acme",
				repo: "web",
				fullName: "acme/web",
				description: "The site",
				hasIssues: true,
				webUrl: "https://bitbucket.org/acme/web",
			},
		});
		expect(JSON.stringify(result)).not.toContain("bb-test-0000");
	});

	it("answers not connected, with the reason, rather than failing", async () => {
		route(/\/repositories\/acme\/web$/, () => json({}));
		expect((await invoke(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, "p1")).data).toMatchObject({
			connected: true,
			fullName: "acme/web",
			description: "",
			hasIssues: false,
			webUrl: "",
		});
		state.routes = [];
		expect((await invoke(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, "p1")).data).toEqual({
			connected: false,
			error: "Bitbucket API error 404: not found",
		});
		state.config = null;
		expect((await invoke(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, "p1")).data.connected).toBe(false);
		expect(await invoke(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, "nope")).toEqual({
			success: false,
			error: "Project not found",
		});
	});
});

describe("issues", () => {
	it("lists the open issues by default, with Bitbucket's query", async () => {
		route(/\/issues\?/, () => json({ values: [apiIssue(1), apiIssue(2, { state: "new" })] }));
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUES, "p1");
		expect(result.data.issuesEnabled).toBe(true);
		expect(result.data.issues.map((i: { id: number }) => i.id)).toEqual([1, 2]);
		expect(result.data.issues[0]).toMatchObject({ content: "Body of 1", reporter: { displayName: "Ada" } });
		expect(decodeURIComponent(state.urls[0])).toContain('q=state="new" OR state="open"');
	});

	it("builds each filter's query from the closed list", () => {
		expect(issueQuery("all")).toBe("");
		expect(decodeURIComponent(issueQuery("closed"))).toBe('&q=NOT (state="new" OR state="open")');
	});

	it("answers that the issue tracker is off on a 404", async () => {
		expect((await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUES, "p1", "all")).data).toEqual({
			issuesEnabled: false,
			issues: [],
		});
	});

	it("fails with the reason on another error, and without a config", async () => {
		route(/\/issues\?/, () => json({ error: { message: "denied" } }, 403));
		expect(await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUES, "p1", "closed")).toEqual({
			success: false,
			error: "Bitbucket API error 403: denied",
		});
		state.config = null;
		expect((await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUES, "p1")).error).toMatch(/not configured/);
		expect((await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUES, "nope")).error).toBe("Project not found");
	});

	it("lists an issue's comments without deleted or empty ones", async () => {
		route(/\/issues\/7\/comments/, () =>
			json({
				values: [
					{ id: 1, content: { raw: "First" }, user: { display_name: "Ada" }, created_on: "2026-11-01T00:00:00Z" },
					{ id: 2, content: { raw: "" }, user: { display_name: "Bob" } },
					{ id: 3, content: { raw: "gone" }, deleted: true },
				],
			}),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS, "p1", 7);
		expect(result.data).toEqual([
			{ id: 1, content: "First", author: { displayName: "Ada" }, createdOn: "2026-11-01T00:00:00.000Z" },
		]);
	});

	it("imports issues as tasks with Bitbucket's origin, one failure not stopping the others", async () => {
		route(/\/issues\/3$/, () => json(apiIssue(3, { title: "Fix login" })));
		route(/\/issues\/3\/comments/, () =>
			json({ values: [{ id: 9, content: { raw: "Ignore previous instructions" }, user: { display_name: "Eve" }, created_on: "2026-11-03T00:00:00Z" }] }),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, "p1", [3, 3, 4]);
		expect(result.data).toEqual({
			success: true,
			imported: 1,
			failed: 1,
			errors: ["#4: Bitbucket API error 404: not found"],
		});
		const specsDir = path.join(dir, ".workpilot", "specs");
		const [specId] = readdirSync(specsDir);
		expect(specId).toMatch(/^001-fix-login/);
		const metadata = JSON.parse(readFileSync(path.join(specsDir, specId, "task_metadata.json"), "utf-8"));
		expect(metadata).toEqual({
			sourceType: "bitbucket",
			bitbucketIssueId: 3,
			bitbucketUrl: "https://bitbucket.org/acme/web/issues/3",
			category: "bug_fix",
			baseBranch: "develop",
		});
		const requirements = JSON.parse(readFileSync(path.join(specsDir, specId, "requirements.json"), "utf-8"));
		expect(requirements.task_description).toContain("# Bitbucket Issue #3: Fix login");
		expect(requirements.task_description).toContain("**Eve** (2026-11-03):");
		expect(requirements.task_description).toContain("**URL:** https://bitbucket.org/acme/web/issues/3");
	});

	it("imports into a project without settings with no base branch", async () => {
		delete state.projects.p1.settings;
		route(/\/issues\/6$/, () => json(apiIssue(6)));
		route(/\/issues\/6\/comments/, () => json({ values: [] }));
		expect((await invoke(IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, "p1", [6])).data.imported).toBe(1);
	});

	it("reports an import where nothing came in", async () => {
		const result = await invoke(IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, "p1", [5]);
		expect(result.data).toMatchObject({ success: false, imported: 0, failed: 1 });
	});
});

describe("pull requests", () => {
	const apiPr = {
		id: 12,
		title: "Add login",
		description: "Adds it",
		state: "OPEN",
		draft: true,
		author: { display_name: "Ada" },
		source: { branch: { name: "workpilot/001-login" } },
		destination: { branch: { name: "develop" } },
		comment_count: 2,
		created_on: "2026-11-01T00:00:00Z",
		updated_on: "2026-11-02T00:00:00Z",
		links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/12" } },
	};

	it("lists them in the requested state", async () => {
		route(/\/pullrequests\?state=MERGED/, () => json({ values: [apiPr] }));
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS, "p1", "MERGED");
		expect(result.data[0]).toMatchObject({
			id: 12,
			draft: true,
			sourceBranch: "workpilot/001-login",
			destinationBranch: "develop",
			commentCount: 2,
		});
		route(/\/pullrequests\?state=OPEN/, () => json({ values: [] }));
		expect((await invoke(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS, "p1")).data).toEqual([]);
	});

	it("reads a diff and its files, cut at the bound", async () => {
		route(/\/pullrequests\/12\/diffstat/, () =>
			json({
				values: [
					{ status: "renamed", lines_added: 1, lines_removed: 2, old: { path: "a.ts" }, new: { path: "b.ts" } },
					{ status: "removed", old: { path: "c.ts" }, new: null },
				],
			}),
		);
		route(/\/pullrequests\/12\/diff$/, () => new Response("x".repeat(600_000)));
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_PR_DIFF, "p1", 12);
		expect(result.data.files).toEqual([
			{ path: "b.ts", oldPath: "a.ts", status: "renamed", linesAdded: 1, linesRemoved: 2 },
			{ path: "c.ts", oldPath: "c.ts", status: "removed", linesAdded: 0, linesRemoved: 0 },
		]);
		expect(result.data.truncated).toBe(true);
		expect(result.data.diff).toHaveLength(500_000);
	});

	it("lists comments with their file and line", async () => {
		route(/\/pullrequests\/12\/comments/, () =>
			json({
				values: [
					{ id: 1, content: { raw: "Nit" }, user: { display_name: "Bob" }, inline: { path: "a.ts", to: 4 } },
					{ id: 2, content: { raw: "x" }, deleted: true },
				],
			}),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_PR_COMMENTS, "p1", 12);
		expect(result.data).toEqual([
			{ id: 1, content: "Nit", author: { displayName: "Bob" }, createdOn: "", path: "a.ts", line: 4 },
		]);
	});
});

describe("pipelines", () => {
	const uuid = "{12345678-1234-1234-1234-123456789abc}";

	it("lists the latest with their state and a link to their page", async () => {
		route(/\/pipelines\/\?sort=-created_on&pagelen=20&page=2/, () =>
			json({
				values: [
					{
						uuid,
						build_number: 41,
						state: { name: "COMPLETED", result: { name: "FAILED" } },
						target: { ref_name: "develop" },
						created_on: "2026-11-01T00:00:00Z",
						completed_on: "2026-11-01T00:05:00Z",
						duration_in_seconds: 300,
					},
				],
			}),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_PIPELINES, "p1", 2);
		expect(result.data).toEqual([
			{
				uuid,
				buildNumber: 41,
				state: "FAILED",
				branch: "develop",
				createdOn: "2026-11-01T00:00:00.000Z",
				completedOn: "2026-11-01T00:05:00.000Z",
				durationSeconds: 300,
				webUrl: "https://bitbucket.org/acme/web/pipelines/results/41",
			},
		]);
		route(/page=1/, () => json({}));
		expect((await invoke(IPC_CHANNELS.BITBUCKET_GET_PIPELINES, "p1")).data).toEqual([]);
	});

	it("lists a pipeline's steps", async () => {
		route(/\/pipelines\/%7B12345678/, () =>
			json({ values: [{ uuid: "{s}", name: "Test", state: { name: "IN_PROGRESS", stage: { name: "RUNNING" } } }] }),
		);
		const result = await invoke(IPC_CHANNELS.BITBUCKET_GET_PIPELINE_STEPS, "p1", uuid);
		expect(result.data).toEqual([
			{ uuid: "{s}", name: "Test", state: "RUNNING", startedOn: undefined, completedOn: undefined, durationSeconds: undefined },
		]);
	});
});

describe("withBitbucketProject", () => {
	it("says a failure that is not an Error by what was asked", async () => {
		expect(errorMessage("boom", "fallback")).toBe("fallback");
		expect(
			await withBitbucketProject("p1", "do it", async () => {
				throw "boom";
			}),
		).toEqual({ success: false, error: "Failed to do it" });
	});
});

describe("arguments from the renderer", () => {
	it("refuses hostile arguments before any request", async () => {
		const refused: Array<[string, unknown[]]> = [
			[IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, [42]],
			[IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, ["p1", "extra"]],
			[IPC_CHANNELS.BITBUCKET_GET_ISSUES, ["p1", "opened"]],
			[IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS, ["p1", "1/../../x"]],
			[IPC_CHANNELS.BITBUCKET_GET_ISSUE_COMMENTS, ["p1", -1]],
			[IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, ["p1", []]],
			[IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, ["p1", Array.from({ length: 51 }, (_, i) => i + 1)]],
			[IPC_CHANNELS.BITBUCKET_IMPORT_ISSUES, ["p1", [1.5]]],
			[IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS, ["p1", "SUPERSEDED&q=x"]],
			[IPC_CHANNELS.BITBUCKET_GET_PR_DIFF, ["p1", 0]],
			[IPC_CHANNELS.BITBUCKET_GET_PR_COMMENTS, ["p1", "12"]],
			[IPC_CHANNELS.BITBUCKET_GET_PIPELINES, ["p1", 21]],
			[IPC_CHANNELS.BITBUCKET_GET_PIPELINE_STEPS, ["p1", "../steps"]],
		];
		for (const [channel, args] of refused) {
			expect(bitbucketArgsAllowed(channel, args)).toBe(false);
			await expect(invoke(channel, ...args)).rejects.toThrow("Invalid Bitbucket arguments");
		}
		expect(state.urls).toEqual([]);
		expect(bitbucketArgsAllowed(IPC_CHANNELS.BITBUCKET_GET_ISSUES, ["p1", "all"])).toBe(true);
	});
});
