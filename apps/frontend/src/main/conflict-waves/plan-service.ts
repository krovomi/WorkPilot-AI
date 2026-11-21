/**
 * Builds an execution wave plan for a project: validates what the renderer
 * sent, resolves the project and its tasks here, reads the worktrees, runs the
 * pure planner, then test-merges the pairs it put together under the
 * tolerance (`merge-check.ts`). The renderer names a project and tasks by id,
 * never a path; the max parallelism is the project's own setting, not a
 * renderer value.
 */

import type {
	ExecutionWaveOptions,
	ExecutionWavePlan,
	UnplannedPolicy,
} from "../../shared/types/conflict-waves";
import type { Project } from "../../shared/types/project";
import type { Task, TaskPriority, TaskStatus } from "../../shared/types/task";
import type { SpecCode } from "./code-links";
import type { CodeReadBudget } from "./code-reader";
import type { CoChanges } from "./fragile-zones";
import { type MergeCheckDeps, planWithMergeChecks } from "./merge-check";
import { type PlannerTask, planExecutionWaves } from "./planner";
import { buildFootprint, type Footprint } from "./scorer";
import type { SpecCodeSource } from "./worktree-files";

/** A project id is a UUID the main process minted. */
export const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
/**
 * A task id is its spec folder name, which may keep accents: letters, digits,
 * marks, `.`, `_`, `-`, nothing that separates a path. It is only ever looked
 * up in the project's own task list.
 */
export const TASK_ID = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,199}$/u;
export const MAX_PLAN_TASKS = 200;
const DEFAULT_MAX_PARALLEL = 3;
export const MAX_PARALLEL_CEILING = 32;
const MAX_TOLERANCE = 100;
const MAX_DRIFT_THRESHOLD = 1000;
const DEFAULT_DRIFT_THRESHOLD = 3;

/** Statuses a plan may schedule: not started yet. */
const PLANNABLE: ReadonlySet<TaskStatus> = new Set(["backlog", "queue"]);
/** Statuses that hold a running build, read for drift and running conflicts. */
const RUNNING: ReadonlySet<TaskStatus> = new Set(["in_progress", "ai_review"]);

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
	urgent: 4,
	high: 3,
	medium: 2,
	low: 1,
};

export interface ValidatedWaveRequest {
	projectId: string;
	taskIds: string[] | null;
	tolerance: number;
	unplannedPolicy: UnplannedPolicy;
	driftThreshold: number;
	fragileZones: boolean;
	codeLinks: boolean;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(
	value: unknown,
	fallback: number,
	max: number,
): number | null {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < 0 || value > max) return null;
	return value;
}

export function validateWavePlanRequest(raw: unknown): Validation<ValidatedWaveRequest> {
	if (!isRecord(raw)) return { ok: false, error: "Invalid request" };
	const { projectId, taskIds, options } = raw;
	if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
		return { ok: false, error: "Invalid project id" };
	}

	let ids: string[] | null = null;
	if (taskIds !== undefined) {
		if (!Array.isArray(taskIds) || taskIds.length > MAX_PLAN_TASKS) {
			return { ok: false, error: "Invalid task list" };
		}
		if (!taskIds.every((id): id is string => typeof id === "string" && TASK_ID.test(id))) {
			return { ok: false, error: "Invalid task id" };
		}
		ids = [...new Set(taskIds)];
	}

	if (options !== undefined && !isRecord(options)) {
		return { ok: false, error: "Invalid options" };
	}
	const opts = (options ?? {}) as ExecutionWaveOptions;
	const tolerance = boundedNumber(opts.tolerance, 0, MAX_TOLERANCE);
	if (tolerance === null) return { ok: false, error: "Invalid tolerance" };
	const driftThreshold = boundedNumber(
		opts.driftThreshold,
		DEFAULT_DRIFT_THRESHOLD,
		MAX_DRIFT_THRESHOLD,
	);
	if (driftThreshold === null) return { ok: false, error: "Invalid drift threshold" };
	const policy = opts.unplannedPolicy ?? "isolate";
	if (policy !== "isolate" && policy !== "independent") {
		return { ok: false, error: "Invalid unplanned policy" };
	}
	const fragileZones = opts.fragileZones ?? true;
	if (typeof fragileZones !== "boolean") return { ok: false, error: "Invalid fragile zones option" };
	const codeLinks = opts.codeLinks ?? true;
	if (typeof codeLinks !== "boolean") return { ok: false, error: "Invalid code links option" };

	return {
		ok: true,
		value: {
			projectId,
			taskIds: ids,
			tolerance,
			unplannedPolicy: policy,
			driftThreshold,
			fragileZones,
			codeLinks,
		},
	};
}

export interface WavePlanDeps extends MergeCheckDeps {
	getProject: (projectId: string) => Project | undefined;
	getTasks: (projectId: string) => Task[];
	readWorktreeFiles: (
		projectPath: string,
		specId: string,
		mainBranch?: string,
	) => Promise<string[] | null>;
	/** Files the project's history changes together, or null when git cannot say. */
	readCoChanges: (projectPath: string) => Promise<CoChanges | null>;
	/** A task's worktree and its diff, for code links. */
	readCodeSource: (
		projectPath: string,
		specId: string,
		mainBranch?: string,
	) => Promise<SpecCodeSource>;
	/** Reads and indexes a spec's files, within the plan's budget. */
	readSpecCode: (
		source: SpecCodeSource,
		projectPath: string,
		footprint: Footprint,
		budget: CodeReadBudget,
	) => Promise<SpecCode>;
	now?: () => Date;
}

function plannedFiles(task: Task): string[] {
	return task.subtasks.flatMap((s) => s.files);
}

function createdAtMs(task: Task): number {
	const ms = new Date(task.createdAt).getTime();
	return Number.isNaN(ms) ? 0 : ms;
}

export function maxParallelOf(project: Project): number {
	const raw = project.settings?.maxParallelTasks;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_PARALLEL;
	return Math.min(MAX_PARALLEL_CEILING, Math.max(1, Math.floor(raw)));
}

export async function buildExecutionWavePlan(
	raw: unknown,
	deps: WavePlanDeps,
): Promise<Validation<ExecutionWavePlan>> {
	const validated = validateWavePlanRequest(raw);
	if (!validated.ok) return validated;
	const request = validated.value;

	const project = deps.getProject(request.projectId);
	if (!project) return { ok: false, error: "Project not found" };
	const all = deps.getTasks(project.id).filter((t) => !t.metadata?.archivedAt);

	let candidates: Task[];
	if (request.taskIds) {
		const byId = new Map(all.map((t) => [t.id, t]));
		candidates = [];
		for (const id of request.taskIds) {
			const task = byId.get(id);
			if (!task) return { ok: false, error: "Task not found in this project" };
			if (!PLANNABLE.has(task.status)) {
				return { ok: false, error: "Only backlog or queued tasks can be planned" };
			}
			candidates.push(task); // ids were deduplicated by the validation
		}
	} else {
		candidates = all.filter((t) => PLANNABLE.has(t.status)).slice(0, MAX_PLAN_TASKS);
	}
	const running = all.filter((t) => RUNNING.has(t.status));

	const toPlanner = async (task: Task): Promise<PlannerTask> => ({
		id: task.id,
		title: task.title,
		status: task.status,
		priorityWeight: PRIORITY_WEIGHT[task.metadata?.priority as TaskPriority] ?? 0,
		createdAtMs: createdAtMs(task),
		// `blockedBy` names tasks by id (the queue resolves it the same way).
		blockedBy: (task.metadata?.blockedBy ?? []).filter((b) => typeof b === "string"),
		plannedFiles: plannedFiles(task),
		actualFiles: await deps.readWorktreeFiles(
			project.path,
			task.specId,
			project.settings?.mainBranch,
		),
	});

	const [plannerCandidates, plannerRunning, coChanges] = await Promise.all([
		Promise.all(candidates.map(toPlanner)),
		Promise.all(running.map(toPlanner)),
		request.fragileZones ? deps.readCoChanges(project.path) : Promise.resolve(null),
	]);
	// Code links: one spec after the other, so that the file budget is shared
	// in a stable order and a large plan never reads everything at once.
	const budget: CodeReadBudget = { read: 0, capped: false };
	if (request.codeLinks) {
		const all = [...plannerCandidates, ...plannerRunning];
		const specOf = new Map([...candidates, ...running].map((t) => [t.id, t.specId]));
		for (const task of all) {
			const footprint = buildFootprint(task.plannedFiles, task.actualFiles ?? []);
			if (footprint.size === 0) continue;
			const specId = specOf.get(task.id) as string;
			const source = await deps.readCodeSource(project.path, specId, project.settings?.mainBranch);
			task.code = await deps.readSpecCode(source, project.path, footprint, budget);
		}
	}
	const maxParallel = maxParallelOf(project);
	// Task id -> spec id, for the candidates that have a worktree to test-merge.
	const withWorktree = new Map<string, string>();
	plannerCandidates.forEach((t, i) => {
		if (t.actualFiles !== null) withWorktree.set(t.id, candidates[i].specId);
	});
	const { result, mergeChecks } = await planWithMergeChecks(
		(checks) =>
			planExecutionWaves(plannerCandidates, plannerRunning, {
				maxParallel,
				tolerance: request.tolerance,
				unplannedPolicy: request.unplannedPolicy,
				driftThreshold: request.driftThreshold,
				mergeChecks: checks,
				coChanges: coChanges?.index,
			}),
		project.path,
		withWorktree,
		deps,
	);

	return {
		ok: true,
		value: {
			projectId: project.id,
			maxParallel,
			tolerance: request.tolerance,
			unplannedPolicy: request.unplannedPolicy,
			...result,
			mergeChecks,
			fragileZones: { enabled: request.fragileZones, commits: coChanges?.commits ?? null },
			codeLinks: { enabled: request.codeLinks, files: budget.read, capped: budget.capped },
			computedAt: (deps.now?.() ?? new Date()).toISOString(),
		},
	};
}
