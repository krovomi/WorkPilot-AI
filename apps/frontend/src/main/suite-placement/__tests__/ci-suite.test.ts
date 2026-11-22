import { describe, expect, it, vi } from "vitest";
import type { CiSuiteRecord } from "../../../shared/types";
import type { PipelineProviderAdapter, PipelineRun } from "../../ci-pipeline-providers";
import {
	approvedSignoffAt,
	commitRun,
	GIVE_UP_AFTER_MS,
	type GitRun,
	nextCiSuiteStep,
	pushTaskBranch,
	readCiSuite,
	TRIGGER_AFTER_MS,
} from "../ci-suite";

const SHA = "c".repeat(40);
const PUSHED = Date.parse("2026-11-22T10:00:00Z");
const pending: CiSuiteRecord = {
	state: "pending",
	branch: "workpilot/001-x",
	sha: SHA,
	pushedAt: new Date(PUSHED).toISOString(),
};
const run = (state: PipelineRun["state"], queueTime?: string): PipelineRun => ({
	state,
	runId: 1,
	webUrl: "https://ci.example/1",
	queueTime,
});

describe("nextCiSuiteStep", () => {
	it("follows the commit's run", () => {
		expect(nextCiSuiteStep(pending, run("succeeded"), PUSHED, true).kind).toBe("passed");
		expect(nextCiSuiteStep(pending, run("partiallySucceeded"), PUSHED, true).kind).toBe("passed");
		expect(nextCiSuiteStep(pending, run("failed"), PUSHED, true).kind).toBe("failed");
		expect(nextCiSuiteStep(pending, run("canceled"), PUSHED, true).kind).toBe("failed");
		expect(nextCiSuiteStep(pending, run("running"), PUSHED, true).kind).toBe("wait");
	});

	it("starts a pipeline after three minutes without one, once", () => {
		expect(nextCiSuiteStep(pending, null, PUSHED + TRIGGER_AFTER_MS - 1, true).kind).toBe("wait");
		expect(nextCiSuiteStep(pending, null, PUSHED + TRIGGER_AFTER_MS, true).kind).toBe("trigger");
		expect(nextCiSuiteStep(pending, null, PUSHED + TRIGGER_AFTER_MS, false).kind).toBe("wait");
		const triggered = { ...pending, triggered: true };
		expect(nextCiSuiteStep(triggered, null, PUSHED + TRIGGER_AFTER_MS, true).kind).toBe("wait");
	});

	it("gives up after twenty minutes, and on an unreadable push time", () => {
		expect(nextCiSuiteStep(pending, null, PUSHED + GIVE_UP_AFTER_MS, true).kind).toBe("not_started");
		expect(nextCiSuiteStep({ ...pending, pushedAt: "never" }, null, PUSHED, true).kind).toBe("not_started");
	});

	it("leaves a settled suite alone", () => {
		expect(nextCiSuiteStep({ ...pending, state: "passed" }, run("failed"), PUSHED, true).kind).toBe("wait");
	});
});

describe("commitRun", () => {
	it("asks the forge for the commit when it can", async () => {
		const fetchCommitRun = vi.fn(async () => run("running"));
		const adapter = { fetchCommitRun, fetchLatestRun: vi.fn() } as unknown as PipelineProviderAdapter;
		expect((await commitRun(adapter, pending))?.state).toBe("running");
		expect(fetchCommitRun).toHaveBeenCalledWith("workpilot/001-x", SHA);
	});

	it("else takes the latest run only when it was queued after the push", async () => {
		const latest = vi.fn();
		const adapter = { fetchLatestRun: latest } as unknown as PipelineProviderAdapter;
		latest.mockResolvedValueOnce(run("failed", "2026-11-22T09:59:00Z"));
		expect(await commitRun(adapter, pending)).toBeNull();
		latest.mockResolvedValueOnce(run("failed", "2026-11-22T10:01:00Z"));
		expect((await commitRun(adapter, pending))?.state).toBe("failed");
		latest.mockResolvedValueOnce(run("failed"));
		expect(await commitRun(adapter, pending)).toBeNull();
		latest.mockResolvedValueOnce(null);
		expect(await commitRun(adapter, pending)).toBeNull();
	});
});

function fakeGit(answers: Record<string, string | Error>): { git: GitRun; calls: string[][] } {
	const calls: string[][] = [];
	const git: GitRun = async (_cwd, args) => {
		calls.push(args);
		const answer = answers[args[0] === "rev-parse" ? args.join(" ") : args[0]];
		if (answer instanceof Error) throw answer;
		return answer ?? "";
	};
	return { git, calls };
}

describe("pushTaskBranch", () => {
	const base = {
		"rev-parse --abbrev-ref HEAD": "workpilot/001-x\n",
		"rev-parse HEAD": `${SHA.toUpperCase()}\n`,
		remote: "git@example:o/r.git",
		push: "",
	};

	it("pushes the task branch to origin, never forced", async () => {
		const { git, calls } = fakeGit(base);
		expect(await pushTaskBranch("/wt", git)).toEqual({ ok: true, branch: "workpilot/001-x", sha: SHA });
		const push = calls.find((args) => args[0] === "push");
		expect(push).toEqual(["push", "origin", "workpilot/001-x:refs/heads/workpilot/001-x"]);
	});

	it("refuses a branch that is not a task branch", async () => {
		for (const branch of ["main", "workpilot/--upload-pack=x", "workpilot/a..b", "HEAD"]) {
			const { git, calls } = fakeGit({ ...base, "rev-parse --abbrev-ref HEAD": branch });
			expect(await pushTaskBranch("/wt", git)).toEqual({ ok: false, reason: "not_a_task_branch" });
			expect(calls.some((args) => args[0] === "push")).toBe(false);
		}
	});

	it("says when there is no remote or the push is refused", async () => {
		expect(await pushTaskBranch("/wt", fakeGit({ ...base, remote: new Error("no origin") }).git)).toEqual({
			ok: false,
			reason: "no_remote",
		});
		const refused = await pushTaskBranch("/wt", fakeGit({ ...base, push: new Error("non-fast-forward") }).git);
		expect(refused).toMatchObject({ ok: false, reason: "push_failed", detail: "non-fast-forward" });
	});
});

describe("plan fields", () => {
	it("reads the approved sign-off only", () => {
		expect(approvedSignoffAt(null)).toBeNull();
		expect(approvedSignoffAt({ qa_signoff: { status: "rejected", timestamp: "t" } })).toBeNull();
		expect(approvedSignoffAt({ qa_signoff: { status: "approved", timestamp: "2026-11-22T10:00:00Z" } })).toBe(
			"2026-11-22T10:00:00Z",
		);
		expect(approvedSignoffAt({ qa_signoff: { status: "approved" } })).toBe("approved");
	});

	it("reads only a record this module wrote", () => {
		expect(readCiSuite({ ciSuite: pending })).toEqual(pending);
		expect(readCiSuite(null)).toBeNull();
		expect(readCiSuite({ ciSuite: { ...pending, state: "odd" } })).toBeNull();
		expect(readCiSuite({ ciSuite: { ...pending, branch: "main" } })).toBeNull();
		expect(readCiSuite({ ciSuite: { ...pending, sha: "" } })).toBeNull();
		expect(readCiSuite({ ciSuite: { ...pending, pushedAt: 3 } })).toBeNull();
		const unpushed = { ...pending, state: "not_started", sha: "" };
		expect(readCiSuite({ ciSuite: unpushed })).toEqual(unpushed);
	});
});
