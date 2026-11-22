/**
 * The runs of one pushed commit and the pipelines started by hand, on each
 * forge the « Build rouge » loop follows (`ci-pipeline-providers.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";
import { foldRuns, resolvePipelineProvider } from "../ci-pipeline-providers";

vi.mock("../ipc-handlers/github/utils", () => ({
	getGitHubConfig: vi.fn(() => null),
	normalizeRepoReference: (repo: string) => repo,
}));
vi.mock("../ipc-handlers/gitlab/utils", () => ({
	getGitLabConfig: vi.fn(async () => null),
	normalizeProjectReference: (project: string) => project,
}));

const project = { id: "p1", path: "/tmp/proj", autoBuildPath: ".workpilot" } as Project;
const SHA = "a".repeat(40);
const BRANCH = "workpilot/001-x";

interface Call {
	url: string;
	method: string;
	body?: unknown;
}

/** Answers by URL fragment; records every call. */
function stubForge(routes: Array<[string, number, unknown]>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			calls.push({
				url: String(url),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(init.body) : undefined,
			});
			const route = routes.find(([fragment]) => String(url).includes(fragment));
			const [, status, payload] = route ?? ["", 404, {}];
			return {
				ok: status < 300,
				status,
				headers: new Headers(),
				json: async () => payload,
				text: async () => JSON.stringify(payload),
			};
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("foldRuns", () => {
	const run = (state: "failed" | "running" | "succeeded" | "canceled" | "queued" | "partiallySucceeded") => ({
		state,
		runId: state,
	});

	it("is red when one run is red, pending while one runs, green when all are", () => {
		expect(foldRuns([])).toBeNull();
		expect(foldRuns([run("succeeded"), run("failed"), run("running")])?.state).toBe("failed");
		expect(foldRuns([run("succeeded"), run("canceled")])?.state).toBe("canceled");
		expect(foldRuns([run("succeeded"), run("queued")])?.state).toBe("queued");
		expect(foldRuns([run("succeeded"), run("partiallySucceeded")])?.state).toBe("partiallySucceeded");
		expect(foldRuns([run("succeeded"), run("succeeded")])?.state).toBe("succeeded");
	});
});

describe("GitHub Actions", () => {
	const github = () =>
		resolvePipelineProvider(project, { CICD_PROVIDER: "github", GITHUB_TOKEN: "t", GITHUB_REPO: "o/r" });

	it("folds every workflow run of the commit", async () => {
		const adapter = await github();
		const calls = stubForge([
			[
				"head_sha=",
				200,
				{
					workflow_runs: [
						{ id: 1, status: "completed", conclusion: "success" },
						{ id: 2, status: "in_progress" },
					],
				},
			],
		]);
		const run = await adapter?.fetchCommitRun?.(BRANCH, SHA);
		expect(run?.state).toBe("running");
		expect(calls[0].url).toContain(`head_sha=${SHA}`);
		expect(calls[0].url).toContain("branch=workpilot%2F001-x");
	});

	it("starts only the workflows that validated pull requests", async () => {
		const adapter = await github();
		const calls = stubForge([
			["event=pull_request", 200, { workflow_runs: [{ workflow_id: 11 }, { workflow_id: 11 }, { workflow_id: 12 }, {}] }],
			["/workflows/11/dispatches", 204, {}],
			["/workflows/12/dispatches", 422, {}],
		]);
		expect(await adapter?.triggerRun?.(BRANCH)).toBe(true);
		const posts = calls.filter((call) => call.method === "POST");
		expect(posts.map((call) => call.url)).toEqual([
			"https://api.github.com/repos/o/r/actions/workflows/11/dispatches",
			"https://api.github.com/repos/o/r/actions/workflows/12/dispatches",
		]);
		expect(posts[0].body).toEqual({ ref: BRANCH });
	});

	it("starts nothing when no workflow validates pull requests", async () => {
		const adapter = await github();
		stubForge([["event=pull_request", 200, { workflow_runs: [] }]]);
		expect(await adapter?.triggerRun?.(BRANCH)).toBe(false);
	});
});

describe("GitLab CI", () => {
	const gitlab = () =>
		resolvePipelineProvider(project, {
			CICD_PROVIDER: "gitlab",
			CICD_GITLAB_TOKEN: "t",
			CICD_GITLAB_PROJECT_ID: "grp/app",
		});

	it("reads the commit's pipelines and starts the branch's own", async () => {
		const adapter = await gitlab();
		const calls = stubForge([
			["/pipelines?", 200, [{ id: 5, status: "success" }, { id: 6, status: "failed" }]],
			["/pipeline?ref=", 201, { id: 7 }],
		]);
		expect((await adapter?.fetchCommitRun?.(BRANCH, SHA))?.state).toBe("failed");
		expect(calls[0].url).toContain(`sha=${SHA}`);
		expect(await adapter?.triggerRun?.(BRANCH)).toBe(true);
		expect(calls[1].url).toContain("/pipeline?ref=workpilot%2F001-x");
	});
});

describe("Azure DevOps", () => {
	const azure = () =>
		resolvePipelineProvider(project, {
			AZURE_DEVOPS_PAT: "pat",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/org",
			AZURE_DEVOPS_PROJECT: "Proj",
		});

	it("keeps only the builds of the commit", async () => {
		const adapter = await azure();
		stubForge([
			[
				"branchName=",
				200,
				{
					value: [
						{ id: 1, status: "completed", result: "failed", sourceVersion: "b".repeat(40) },
						{ id: 2, status: "completed", result: "succeeded", sourceVersion: SHA.toUpperCase() },
					],
				},
			],
		]);
		const run = await adapter?.fetchCommitRun?.(BRANCH, SHA);
		expect(run?.state).toBe("succeeded");
		expect(run?.runId).toBe(2);
	});

	it("queues the definitions that validated pull requests", async () => {
		const adapter = await azure();
		const calls = stubForge([
			["reasonFilter=pullRequest", 200, { value: [{ id: 1, definition: { id: 9 } }, { id: 2, definition: { id: 9 } }] }],
			["_apis/build/builds?api-version", 200, { id: 3 }],
		]);
		expect(await adapter?.triggerRun?.(BRANCH)).toBe(true);
		const post = calls.find((call) => call.method === "POST");
		expect(post?.body).toEqual({ definition: { id: 9 }, sourceBranch: `refs/heads/${BRANCH}` });
	});
});

describe("Bitbucket Pipelines", () => {
	const bitbucket = () =>
		resolvePipelineProvider(project, {
			CICD_PROVIDER: "bitbucket",
			BITBUCKET_ENABLED: "true",
			BITBUCKET_WORKSPACE: "ws",
			BITBUCKET_REPO: "repo",
			BITBUCKET_TOKEN: "tok",
		});

	it("reads the commit's pipelines and starts the branch's own", async () => {
		const adapter = await bitbucket();
		expect(adapter?.id).toBe("bitbucket-pipelines");
		const pipeline = (uuid: string, hash: string, state: string) => ({
			uuid,
			build_number: 1,
			state: { name: state === "SUCCESSFUL" ? "COMPLETED" : state, result: { name: state } },
			target: { ref_name: BRANCH, commit: { hash } },
			created_on: "2026-11-22T09:00:00Z",
		});
		const calls = stubForge([
			[
				"/pipelines/?",
				200,
				{
					values: [
						pipeline("{11111111-1111-1111-1111-111111111111}", "b".repeat(40), "FAILED"),
						pipeline("{22222222-2222-2222-2222-222222222222}", SHA, "SUCCESSFUL"),
					],
				},
			],
			["/pipelines/", 201, { uuid: "{3}" }],
		]);
		const run = await adapter?.fetchCommitRun?.(BRANCH, SHA);
		expect(run?.runId).toBe("{22222222-2222-2222-2222-222222222222}");
		expect(await adapter?.triggerRun?.(BRANCH)).toBe(true);
		const post = calls.find((call) => call.method === "POST");
		expect(post?.body).toEqual({
			target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: BRANCH },
		});
	});
});
