/**
 * A task's CI suite on a real project folder: the build's decision and plan
 * on disk, git and the forge faked.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiSuiteRecord, Project, Task } from "../../../shared/types";
import type { PipelineProviderAdapter } from "../../ci-pipeline-providers";
import { type GitRun, GIVE_UP_AFTER_MS, TRIGGER_AFTER_MS } from "../ci-suite";
import { advanceCiSuite, beginCiSuite, taskCiSuite } from "../ci-suite-flow";
import { ciRouteAvailable, resetCiRoutes, setCiFollowed } from "../ci-route";

const SHA = "d".repeat(40);
let root: string;
let project: Project;
const task = { id: "t1", specId: "001-x" } as Task;

function specDir(): string {
	return path.join(root, ".workpilot", "specs", task.specId);
}

function writePlan(plan: Record<string, unknown>): void {
	writeFileSync(path.join(specDir(), "implementation_plan.json"), JSON.stringify(plan), "utf-8");
}

function plan(): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(specDir(), "implementation_plan.json"), "utf-8"));
}

function decide(target: string): void {
	writeFileSync(
		path.join(specDir(), "test_placement.json"),
		JSON.stringify({ target, reason: "branch_push", mode: "auto", short: ["cpu"], facts: {} }),
		"utf-8",
	);
}

const git = (push: () => void = () => {}): GitRun =>
	vi.fn(async (_cwd: string, args: string[]) => {
		if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return "workpilot/001-x";
		if (args.join(" ") === "rev-parse HEAD") return SHA;
		if (args[0] === "push") push();
		return "";
	});

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	root = mkdtempSync(path.join(tmpdir(), "ci-suite-"));
	mkdirSync(specDir(), { recursive: true });
	mkdirSync(path.join(root, ".workpilot", "worktrees", "tasks", task.specId), { recursive: true });
	project = { id: "p1", path: root, autoBuildPath: ".workpilot" } as Project;
	writePlan({ qa_signoff: { status: "approved", timestamp: "2026-11-22T10:00:00Z" } });
});

afterEach(() => {
	resetCiRoutes();
	vi.restoreAllMocks();
});

describe("beginCiSuite", () => {
	it("pushes once per approved sign-off when the build chose the CI", async () => {
		decide("ci");
		const now = () => new Date("2026-11-22T10:05:00Z");
		const record = await beginCiSuite(project, task, { git: git(), now });
		expect(record).toMatchObject({ state: "pending", branch: "workpilot/001-x", sha: SHA });
		expect(taskCiSuite(project, task)).toEqual({
			state: "pending",
			branch: "workpilot/001-x",
			sha: SHA,
			pushedAt: "2026-11-22T10:05:00.000Z",
			signoffAt: "2026-11-22T10:00:00Z",
		});
		const again = git();
		expect(await beginCiSuite(project, task, { git: again, now })).toBeNull();
		expect(again).not.toHaveBeenCalled();
	});

	it("does nothing for a suite run on the machine, a rejected build or no worktree", async () => {
		decide("machine");
		expect(await beginCiSuite(project, task, { git: git() })).toBeNull();
		decide("ci");
		writePlan({ qa_signoff: { status: "rejected" } });
		expect(await beginCiSuite(project, task, { git: git() })).toBeNull();
		writePlan({ qa_signoff: { status: "approved" } });
		const elsewhere = { id: "t2", specId: "002-y" } as Task;
		mkdirSync(path.join(root, ".workpilot", "specs", "002-y"), { recursive: true });
		writeFileSync(
			path.join(root, ".workpilot", "specs", "002-y", "test_placement.json"),
			JSON.stringify({ target: "ci", reason: "pr", mode: "auto" }),
			"utf-8",
		);
		writeFileSync(
			path.join(root, ".workpilot", "specs", "002-y", "implementation_plan.json"),
			JSON.stringify({ qa_signoff: { status: "approved" } }),
			"utf-8",
		);
		expect(await beginCiSuite(project, elsewhere, { git: git() })).toBeNull();
	});

	it("records a push the remote refused as a suite that did not start", async () => {
		decide("ci");
		const record = await beginCiSuite(project, task, {
			git: git(() => {
				throw new Error("rejected");
			}),
		});
		expect(record).toMatchObject({ state: "not_started", reason: "push_failed", sha: "" });
		expect(plan().ciSuite).toMatchObject({ state: "not_started" });
	});
});

describe("advanceCiSuite", () => {
	const pushedAt = Date.parse("2026-11-22T10:05:00Z");
	const pending: CiSuiteRecord = {
		state: "pending",
		branch: "workpilot/001-x",
		sha: SHA,
		pushedAt: new Date(pushedAt).toISOString(),
	};
	const adapter = (trigger?: () => Promise<boolean>) =>
		({
			id: "github-actions",
			label: "GitHub Actions",
			fetchLatestRun: vi.fn(),
			fetchRunErrors: vi.fn(),
			...(trigger ? { triggerRun: vi.fn(trigger) } : {}),
		}) as unknown as PipelineProviderAdapter;

	it("records the commit's verdict", async () => {
		const green = await advanceCiSuite(project, task, adapter(), pending, {
			state: "succeeded",
			runId: 1,
			webUrl: "https://ci/1",
		});
		expect(green).toMatchObject({ state: "passed", webUrl: "https://ci/1" });
		expect(plan().ciSuite).toMatchObject({ state: "passed" });
		const red = await advanceCiSuite(project, task, adapter(), pending, { state: "failed", runId: 2 });
		expect(red.state).toBe("failed");
	});

	it("starts the pipeline once when the push started none", async () => {
		const forge = adapter(async () => true);
		const next = await advanceCiSuite(project, task, forge, pending, null, pushedAt + TRIGGER_AFTER_MS);
		expect(next.triggered).toBe(true);
		expect(forge.triggerRun).toHaveBeenCalledWith("workpilot/001-x");
		const failing = adapter(async () => {
			throw new Error("403");
		});
		const still = await advanceCiSuite(project, task, failing, pending, null, pushedAt + TRIGGER_AFTER_MS);
		expect(still.triggered).toBe(true);
	});

	it("gives the route up for the project when no pipeline ever ran", async () => {
		setCiFollowed("p1", true);
		const next = await advanceCiSuite(project, task, adapter(), pending, null, pushedAt + GIVE_UP_AFTER_MS);
		expect(next).toMatchObject({ state: "not_started", reason: "no_pipeline" });
		expect(ciRouteAvailable("p1", pushedAt + GIVE_UP_AFTER_MS + 1)).toBe(false);
	});

	it("waits without writing while the pipeline runs", async () => {
		const before = readFileSync(path.join(specDir(), "implementation_plan.json"), "utf-8");
		const same = await advanceCiSuite(project, task, adapter(), pending, { state: "running", runId: 3 });
		expect(same).toBe(pending);
		expect(readFileSync(path.join(specDir(), "implementation_plan.json"), "utf-8")).toBe(before);
	});
});
