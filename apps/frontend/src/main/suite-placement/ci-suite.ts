/**
 * A task's full suite sent to the forge's CI (`test_placement.json` says
 * `ci`): the branch is pushed without a pull request, its pipeline followed
 * by commit, started by hand when the push alone started none.
 *
 * - `startCiSuite`, when a build ends with an approved QA sign-off, pushes the
 *   task's branch (no force, the machine's git credentials) and writes
 *   `ciSuite` in the plan: the commit, the push time, the sign-off it answers
 *   (a restart does not push twice).
 * - `nextCiSuiteStep` (pure) reads the commit's runs on each poll of the
 *   « Build rouge » loop: green → passed, red → failed (the loop's red path
 *   then moves the card and repairs it), nothing after three minutes → start
 *   the pipelines that validate pull requests, nothing after twenty → the
 *   suite did not start, and the CI route is left aside for this project for a
 *   day (`ci-route.ts`) so the next suites run on the machine.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	CiSuiteRecord,
	PipelineRunState,
} from "../../shared/types";
import type { PipelineProviderAdapter, PipelineRun } from "../ci-pipeline-providers";
import { getToolPath } from "../cli-tool-manager";
import { getIsolatedGitEnv } from "../utils/git-isolation";

const execFileAsync = promisify(execFile);

export const TRIGGER_AFTER_MS = 3 * 60_000;
export const GIVE_UP_AFTER_MS = 20 * 60_000;
const PUSH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 10_000;

/** A task branch WorkPilot pushes: `workpilot/<spec>`, nothing that git reads as an option. */
const BRANCH = /^workpilot\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const SHA = /^[0-9a-f]{40}$/;

const GREEN: ReadonlySet<PipelineRunState> = new Set(["succeeded", "partiallySucceeded"]);
const RED: ReadonlySet<PipelineRunState> = new Set(["failed", "canceled"]);

export type CiSuiteStep =
	| { kind: "wait" }
	| { kind: "trigger" }
	| { kind: "passed"; run: PipelineRun }
	| { kind: "failed"; run: PipelineRun }
	| { kind: "not_started" };

/** What to do with a pending suite, from its commit's run (or none yet). */
export function nextCiSuiteStep(
	record: CiSuiteRecord,
	run: PipelineRun | null,
	now: number,
	canTrigger: boolean,
): CiSuiteStep {
	if (record.state !== "pending") return { kind: "wait" };
	if (run) {
		if (GREEN.has(run.state)) return { kind: "passed", run };
		if (RED.has(run.state)) return { kind: "failed", run };
		return { kind: "wait" };
	}
	const elapsed = now - Date.parse(record.pushedAt);
	if (!Number.isFinite(elapsed)) return { kind: "not_started" };
	if (elapsed >= GIVE_UP_AFTER_MS) return { kind: "not_started" };
	if (!record.triggered && canTrigger && elapsed >= TRIGGER_AFTER_MS) {
		return { kind: "trigger" };
	}
	return { kind: "wait" };
}

/**
 * The run of the pushed commit: every run of it folded when the forge can
 * say it, else the branch's latest run queued after the push.
 */
export async function commitRun(
	adapter: PipelineProviderAdapter,
	record: CiSuiteRecord,
): Promise<PipelineRun | null> {
	if (adapter.fetchCommitRun) {
		return adapter.fetchCommitRun(record.branch, record.sha);
	}
	const latest = await adapter.fetchLatestRun(record.branch);
	if (!latest?.queueTime) return null;
	return Date.parse(latest.queueTime) >= Date.parse(record.pushedAt) ? latest : null;
}

export type GitRun = (cwd: string, args: string[], timeout: number) => Promise<string>;

export const defaultGitRun: GitRun = async (cwd, args, timeout) => {
	const { stdout } = await execFileAsync(getToolPath("git"), args, {
		cwd,
		encoding: "utf-8",
		timeout,
		env: getIsolatedGitEnv(),
	});
	return stdout;
};

export type PushResult =
	| { ok: true; branch: string; sha: string }
	| { ok: false; reason: "not_a_task_branch" | "no_remote" | "push_failed"; detail?: string };

/** Push the worktree's task branch to `origin`, never forced. */
export async function pushTaskBranch(
	worktreePath: string,
	git: GitRun = defaultGitRun,
): Promise<PushResult> {
	const branch = (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], GIT_TIMEOUT_MS)).trim();
	const sha = (await git(worktreePath, ["rev-parse", "HEAD"], GIT_TIMEOUT_MS)).trim().toLowerCase();
	if (!BRANCH.test(branch) || branch.includes("..") || !SHA.test(sha)) {
		return { ok: false, reason: "not_a_task_branch" };
	}
	try {
		await git(worktreePath, ["remote", "get-url", "origin"], GIT_TIMEOUT_MS);
	} catch {
		return { ok: false, reason: "no_remote" };
	}
	try {
		await git(worktreePath, ["push", "origin", `${branch}:refs/heads/${branch}`], PUSH_TIMEOUT_MS);
	} catch (error) {
		return { ok: false, reason: "push_failed", detail: String((error as Error).message).slice(0, 300) };
	}
	return { ok: true, branch, sha };
}

/** The QA sign-off of a plan when it approved the build, else null. */
export function approvedSignoffAt(plan: Record<string, unknown> | null): string | null {
	const signoff = plan?.qa_signoff as { status?: unknown; timestamp?: unknown } | undefined;
	if (signoff?.status !== "approved") return null;
	return typeof signoff.timestamp === "string" && signoff.timestamp ? signoff.timestamp.slice(0, 64) : "approved";
}

/** The plan's record, when it is one this module wrote. */
export function readCiSuite(plan: Record<string, unknown> | null): CiSuiteRecord | null {
	const raw = plan?.ciSuite as Partial<CiSuiteRecord> | undefined;
	if (!raw || typeof raw !== "object") return null;
	if (!["pending", "passed", "failed", "not_started"].includes(String(raw.state))) return null;
	if (typeof raw.branch !== "string" || !BRANCH.test(raw.branch)) return null;
	// A suite that never started may have no commit (the push failed).
	const shaOk = typeof raw.sha === "string" && (SHA.test(raw.sha) || (raw.state === "not_started" && raw.sha === ""));
	if (!shaOk) return null;
	if (typeof raw.pushedAt !== "string") return null;
	return raw as CiSuiteRecord;
}
