/**
 * @vitest-environment node
 *
 * Bitbucket Pipelines in the « Build rouge » loop: chosen by CICD_PROVIDER or
 * found after GitLab when the project's Bitbucket config is complete; the
 * latest pipeline of a branch and its failed steps, from api.bitbucket.org.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import { resolvePipelineProvider } from "../../../ci-pipeline-providers";
import { BitbucketPipelinesAdapter, bitbucketPipelinesAdapter, runState } from "../pipelines-adapter";

vi.mock("../../github/utils", () => ({
	getGitHubConfig: vi.fn(() => null),
	normalizeRepoReference: (repo: string) => repo,
}));
vi.mock("../../gitlab/utils", () => ({
	getGitLabConfig: vi.fn(async () => null),
	normalizeProjectReference: (project: string) => project,
}));

const ENV = {
	BITBUCKET_ENABLED: "true",
	BITBUCKET_WORKSPACE: "acme",
	BITBUCKET_REPO: "web",
	BITBUCKET_TOKEN: "bb-test-0000",
};
const project = { id: "p1", path: "/tmp/p", autoBuildPath: ".workpilot" } as Project;
const UUID = "{12345678-1234-1234-1234-123456789abc}";

let urls: string[];
let bodies: unknown[];

beforeEach(() => {
	urls = [];
	bodies = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			return new Response(JSON.stringify(bodies.shift() ?? {}), { status: 200 });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("provider resolution", () => {
	it("is chosen explicitly or found from a complete Bitbucket config", async () => {
		expect((await resolvePipelineProvider(project, { ...ENV, CICD_PROVIDER: "bitbucket" }))?.id).toBe(
			"bitbucket-pipelines",
		);
		expect((await resolvePipelineProvider(project, ENV))?.label).toBe("Bitbucket Pipelines");
		expect(await resolvePipelineProvider(project, { ...ENV, BITBUCKET_ENABLED: "false" })).toBeNull();
		expect(bitbucketPipelinesAdapter({})).toBeNull();
	});
});

describe("runs", () => {
	const adapter = () => bitbucketPipelinesAdapter(ENV) as BitbucketPipelinesAdapter;

	it("reads the latest pipeline of a branch", async () => {
		bodies.push({
			values: [
				{
					uuid: UUID,
					build_number: 7,
					state: { name: "COMPLETED", result: { name: "FAILED" } },
					target: { ref_name: "workpilot/001-x" },
					created_on: "2026-11-01T00:00:00Z",
					completed_on: "2026-11-01T00:03:00Z",
				},
			],
		});
		expect(await adapter().fetchLatestRun("workpilot/001-x")).toEqual({
			state: "failed",
			runId: UUID,
			runNumber: "#7",
			definitionName: "workpilot/001-x",
			webUrl: "https://bitbucket.org/acme/web/pipelines/results/7",
			queueTime: "2026-11-01T00:00:00.000Z",
			finishTime: "2026-11-01T00:03:00.000Z",
		});
		expect(urls[0]).toBe(
			"https://api.bitbucket.org/2.0/repositories/acme/web/pipelines/?target.ref_name=workpilot%2F001-x&sort=-created_on&pagelen=1",
		);
	});

	it("has no run without a pipeline, or with one whose uuid is not Bitbucket's", async () => {
		bodies.push({ values: [] });
		expect(await adapter().fetchLatestRun("main")).toBeNull();
		bodies.push({ values: [{ uuid: "../x", build_number: 0, state: {} }] });
		expect(await adapter().fetchLatestRun("main")).toBeNull();
		bodies.push({});
		expect(await adapter().fetchLatestRun("main")).toBeNull();
	});

	it("leaves out the link and dates Bitbucket did not give", async () => {
		bodies.push({ values: [{ uuid: UUID, state: { name: "PENDING" } }] });
		expect(await adapter().fetchLatestRun("main")).toEqual({
			state: "queued",
			runId: UUID,
			runNumber: "#0",
			definitionName: undefined,
			webUrl: undefined,
			queueTime: undefined,
			finishTime: undefined,
		});
	});

	it("names the failed steps of a run, and none for a foreign run id", async () => {
		bodies.push({
			values: [
				{ name: "Build", state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } },
				{ name: "Test", state: { name: "COMPLETED", result: { name: "FAILED" } } },
				{ name: "Lint", state: { name: "COMPLETED", result: { name: "ERROR" } } },
			],
		});
		expect(await adapter().fetchRunErrors({ state: "failed", runId: UUID })).toEqual([
			"[Test] failed",
			"[Lint] error",
		]);
		expect(await adapter().fetchRunErrors({ state: "failed", runId: 12 })).toEqual([]);
		expect(urls).toHaveLength(1);
	});

	it("maps every Bitbucket state", () => {
		expect(runState("SUCCESSFUL")).toBe("succeeded");
		expect(runState("FAILED")).toBe("failed");
		expect(runState("ERROR")).toBe("failed");
		expect(runState("STOPPED")).toBe("canceled");
		expect(runState("EXPIRED")).toBe("canceled");
		expect(runState("RUNNING")).toBe("running");
		expect(runState("IN_PROGRESS")).toBe("running");
		expect(runState("PENDING")).toBe("queued");
	});
});
