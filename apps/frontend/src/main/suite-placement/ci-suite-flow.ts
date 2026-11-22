/**
 * The CI suite of a task on disk: started when a build ends, advanced on each
 * poll of the « Build rouge » loop (`ci-pipeline-service.ts`). Everything it
 * decides comes from `ci-suite.ts`; this file reads and writes the plan.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CiSuiteRecord, Project, Task } from "../../shared/types";
import type { PipelineProviderAdapter, PipelineRun } from "../ci-pipeline-providers";
import { getPlanPath, updatePlanFile } from "../ipc-handlers/task/plan-file-utils";
import { findTaskWorktree } from "../worktree-paths";
import {
	approvedSignoffAt,
	type GitRun,
	nextCiSuiteStep,
	pushTaskBranch,
	readCiSuite,
} from "./ci-suite";
import { suspendCiRoute } from "./ci-route";
import { readSuitePlacement } from "./placement-file";

type PlanJson = Record<string, unknown>;

function readPlan(planPath: string): PlanJson | null {
	try {
		return JSON.parse(readFileSync(planPath, "utf-8")) as PlanJson;
	} catch {
		return null;
	}
}

/** The task's CI suite as the plan holds it, or null. */
export function taskCiSuite(project: Project, task: Task): CiSuiteRecord | null {
	return readCiSuite(readPlan(getPlanPath(project, task)));
}

async function writeRecord(planPath: string, record: CiSuiteRecord): Promise<void> {
	await updatePlanFile<PlanJson>(planPath, (plan) => {
		plan.ciSuite = record;
		return plan;
	});
}

/**
 * After a build: push the branch when the build decided its suite runs on
 * the CI and QA approved; once per sign-off. Null when nothing was pushed.
 */
export async function beginCiSuite(
	project: Project,
	task: Task,
	options: { git?: GitRun; now?: () => Date } = {},
): Promise<CiSuiteRecord | null> {
	const planPath = getPlanPath(project, task);
	const placement = readSuitePlacement(path.dirname(planPath));
	if (placement?.target !== "ci") return null;
	const plan = readPlan(planPath);
	const signoffAt = approvedSignoffAt(plan);
	if (!signoffAt) return null;
	if (readCiSuite(plan)?.signoffAt === signoffAt) return null;
	const worktree = findTaskWorktree(project.path, task.specId);
	if (!worktree) return null;

	const pushedAt = (options.now?.() ?? new Date()).toISOString();
	const pushed = await pushTaskBranch(worktree, options.git);
	const record: CiSuiteRecord = pushed.ok
		? { state: "pending", branch: pushed.branch, sha: pushed.sha, pushedAt, signoffAt }
		: {
				state: "not_started",
				branch: `workpilot/${task.specId}`,
				sha: "",
				pushedAt,
				signoffAt,
				reason: pushed.reason === "push_failed" ? "push_failed" : "no_remote",
			};
	if (!pushed.ok) {
		console.warn(`[CiSuite] ${task.specId}: branch not pushed (${pushed.reason}) ${pushed.detail ?? ""}`);
	}
	await writeRecord(planPath, record);
	return record;
}

/** One poll of a pending suite; returns the record as it now stands. */
export async function advanceCiSuite(
	project: Project,
	task: Task,
	adapter: PipelineProviderAdapter,
	record: CiSuiteRecord,
	run: PipelineRun | null,
	now: number = Date.now(),
): Promise<CiSuiteRecord> {
	const step = nextCiSuiteStep(record, run, now, Boolean(adapter.triggerRun));
	let next: CiSuiteRecord = record;
	switch (step.kind) {
		case "wait":
			return record;
		case "trigger": {
			let started = false;
			try {
				started = (await adapter.triggerRun?.(record.branch)) ?? false;
			} catch (err) {
				console.warn(`[CiSuite] ${task.specId}: could not start a pipeline:`, err);
			}
			console.warn(`[CiSuite] ${task.specId}: pipeline started by hand: ${started}`);
			next = { ...record, triggered: true };
			break;
		}
		case "passed":
		case "failed":
			next = { ...record, state: step.kind, webUrl: step.run.webUrl };
			break;
		case "not_started":
			next = { ...record, state: "not_started", reason: "no_pipeline" };
			suspendCiRoute(project.id, now);
			console.warn(`[CiSuite] ${task.specId}: no pipeline ran the pushed commit; CI route set aside for a day`);
			break;
	}
	await writeRecord(getPlanPath(project, task), next);
	return next;
}
