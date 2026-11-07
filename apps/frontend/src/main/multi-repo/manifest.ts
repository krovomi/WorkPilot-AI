/**
 * The manifest of a multi-repo orchestration, on disk.
 *
 * `<project>/.workpilot/multi-repo/<id>/multi_repo_manifest.json`, shared with
 * the Python runner (`orchestration/cross_repo_spec.py`), hence snake_case.
 * The runner writes the graph, the execution order and the breaking changes;
 * the main process writes each repo's project, task, worktree and status.
 * They never write at the same time: the main process waits for each runner
 * step before it reads the file again.
 *
 * The directory sits outside `.workpilot/specs/` on purpose: every spec
 * directory is a Kanban card, and an orchestration is not one.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
	BreakingChange,
	MultiRepoOrchestration,
	MultiRepoStatus,
	Project,
	RepoDependencyType,
	RepoExecutionStatus,
} from "../../shared/types";
import { slugifySpecTitle } from "../../shared/utils/spec-slug";

export const MANIFEST_FILE = "multi_repo_manifest.json";
const ORCHESTRATION_ID = /^\d{3}-[a-z0-9-]{1,60}$/;

export interface RawRepo {
	repo: string;
	repo_path: string;
	project_id: string;
	task_id: string;
	worktree_path: string;
	status: RepoExecutionStatus;
	pr_url: string;
	branch_name: string;
	base_branch: string;
	progress: number;
	current_phase: string;
	error_message: string;
}

interface RawDependency {
	source_repo: string;
	target_repo: string;
	dependency_type: RepoDependencyType;
	details: string;
}

interface RawBreakingChange {
	source_repo: string;
	target_repo: string;
	change_type: string;
	description: string;
	severity: "warning" | "error";
	file_path: string;
	suggestion: string;
}

export interface RawManifest {
	task_description: string;
	repos: RawRepo[];
	dependency_graph: { repos: string[]; dependencies: RawDependency[] };
	execution_order: string[];
	status: MultiRepoStatus;
	status_message: string;
	status_repo: string;
	created_at: string;
	updated_at: string;
	breaking_changes: RawBreakingChange[];
}

const STATUSES: readonly MultiRepoStatus[] = [
	"pending",
	"analyzing",
	"executing",
	"completed",
	"failed",
	"stopped",
];
const REPO_STATUSES: readonly RepoExecutionStatus[] = [
	"pending",
	"coding",
	"qa",
	"needs_you",
	"completed",
	"failed",
];

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function parseRepo(value: unknown): RawRepo {
	const r = record(value);
	const progress = Number(r.progress);
	return {
		repo: str(r.repo),
		repo_path: str(r.repo_path),
		project_id: str(r.project_id),
		task_id: str(r.task_id),
		worktree_path: str(r.worktree_path),
		// A status this version does not know reads as not started.
		status: oneOf(r.status, REPO_STATUSES, "pending"),
		pr_url: str(r.pr_url),
		branch_name: str(r.branch_name),
		base_branch: str(r.base_branch),
		progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
		current_phase: str(r.current_phase),
		error_message: str(r.error_message),
	};
}

/** The manifest as written, every field typed; unknown values fall back. */
export function parseManifest(value: unknown): RawManifest {
	const m = record(value);
	const graph = record(m.dependency_graph);
	return {
		task_description: str(m.task_description),
		repos: list(m.repos).map(parseRepo),
		dependency_graph: {
			repos: list(graph.repos).map(str),
			dependencies: list(graph.dependencies).map((d) => {
				const dep = record(d);
				return {
					source_repo: str(dep.source_repo),
					target_repo: str(dep.target_repo),
					dependency_type: str(dep.dependency_type) as RepoDependencyType,
					details: str(dep.details),
				};
			}),
		},
		execution_order: list(m.execution_order).map(str),
		status: oneOf(m.status, STATUSES, "pending"),
		status_message: str(m.status_message),
		status_repo: str(m.status_repo),
		created_at: str(m.created_at),
		updated_at: str(m.updated_at),
		breaking_changes: list(m.breaking_changes).map((b) => {
			const bc = record(b);
			return {
				source_repo: str(bc.source_repo),
				target_repo: str(bc.target_repo),
				change_type: str(bc.change_type),
				description: str(bc.description),
				severity: bc.severity === "error" ? "error" : "warning",
				file_path: str(bc.file_path),
				suggestion: str(bc.suggestion),
			};
		}),
	};
}

export function readManifest(dir: string): RawManifest | null {
	try {
		return parseManifest(JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), "utf-8")));
	} catch {
		return null;
	}
}

export function writeManifest(dir: string, manifest: RawManifest): void {
	const file = path.join(dir, MANIFEST_FILE);
	const partial = `${file}.partial`;
	const data = { ...manifest, updated_at: new Date().toISOString() };
	writeFileSync(partial, JSON.stringify(data, null, 2), "utf-8");
	renameSync(partial, file);
}

/** Where a project keeps its orchestrations. */
export function orchestrationsRoot(project: Project): string {
	return path.join(project.path, project.autoBuildPath || ".workpilot", "multi-repo");
}

/** The directory of orchestration `id`, or `null` for an id that is not one. */
export function orchestrationDir(project: Project, id: unknown): string | null {
	if (typeof id !== "string" || !ORCHESTRATION_ID.test(id)) return null;
	return path.join(orchestrationsRoot(project), id);
}

export function listOrchestrationIds(project: Project): string[] {
	const root = orchestrationsRoot(project);
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && ORCHESTRATION_ID.test(d.name))
			.map((d) => d.name)
			.filter((name) => existsSync(path.join(root, name, MANIFEST_FILE)))
			.sort();
	} catch {
		return [];
	}
}

export interface NewRepo {
	name: string;
	path: string;
	projectId: string;
}

/** Writes the first manifest of a new orchestration; answers its id. */
export function createOrchestration(
	project: Project,
	repos: readonly NewRepo[],
	taskDescription: string,
): string {
	const root = orchestrationsRoot(project);
	mkdirSync(root, { recursive: true });
	const highest = listOrchestrationIds(project).reduce(
		(max, id) => Math.max(max, Number.parseInt(id.slice(0, 3), 10)),
		0,
	);
	const slug = slugifySpecTitle(taskDescription, 40) || "task";
	const id = `${String(highest + 1).padStart(3, "0")}-${slug}`;
	const dir = path.join(root, id);
	mkdirSync(dir, { recursive: true });
	const now = new Date().toISOString();
	writeManifest(dir, {
		task_description: taskDescription,
		repos: repos.map((r) => ({
			repo: r.name,
			repo_path: r.path,
			project_id: r.projectId,
			task_id: "",
			worktree_path: "",
			status: "pending",
			pr_url: "",
			branch_name: "",
			base_branch: "",
			progress: 0,
			current_phase: "",
			error_message: "",
		})),
		dependency_graph: { repos: repos.map((r) => r.name), dependencies: [] },
		execution_order: repos.map((r) => r.name),
		status: "pending",
		status_message: "",
		status_repo: "",
		created_at: now,
		updated_at: now,
		breaking_changes: [],
	});
	return id;
}

function toBreakingChange(bc: RawBreakingChange): BreakingChange {
	return {
		sourceRepo: bc.source_repo,
		targetRepo: bc.target_repo,
		changeType: bc.change_type,
		description: bc.description,
		severity: bc.severity,
		filePath: bc.file_path,
		suggestion: bc.suggestion,
	};
}

/** What the renderer sees of an orchestration. */
export function toOrchestration(
	id: string,
	projectId: string,
	m: RawManifest,
	running: boolean,
): MultiRepoOrchestration {
	const overall =
		m.repos.length === 0
			? 0
			: m.repos.reduce((sum, r) => sum + r.progress, 0) / m.repos.length;
	return {
		id,
		projectId,
		taskDescription: m.task_description,
		status: m.status,
		statusKey: m.status_message || undefined,
		statusRepo: m.status_repo || undefined,
		running,
		repos: m.repos.map((r) => ({
			id: r.repo,
			repo: r.repo,
			displayName: r.repo,
			localPath: r.repo_path,
		})),
		dependencyGraph: {
			nodes: m.dependency_graph.repos,
			edges: m.dependency_graph.dependencies.map((d) => ({
				source: d.source_repo,
				target: d.target_repo,
				type: d.dependency_type,
				details: d.details || undefined,
			})),
		},
		executionOrder: m.execution_order,
		repoStates: m.repos.map((r) => ({
			repo: r.repo,
			status: r.status,
			projectId: r.project_id || undefined,
			taskId: r.task_id || undefined,
			prUrl: r.pr_url || undefined,
			branchName: r.branch_name || undefined,
			progress: r.progress,
		})),
		breakingChanges: m.breaking_changes.map(toBreakingChange),
		overallProgress: overall,
		createdAt: m.created_at,
		updatedAt: m.updated_at,
	};
}
