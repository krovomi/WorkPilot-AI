/**
 * Multi-Repo Orchestration Types
 *
 * One change that spans several repositories. Every repository becomes an
 * ordinary Kanban task of its own WorkPilot project; the orchestration starts
 * them one after the other, providers first, and hands each the changes of
 * the repositories done before it (docs/architecture/multi-repo.md).
 */

/** Overall orchestration status */
export type MultiRepoStatus =
	| "pending"
	| "analyzing"
	| "executing"
	| "completed"
	| "failed"
	| "stopped";

/** Per-repo execution status, read from the repo's Kanban task */
export type RepoExecutionStatus =
	| "pending"
	| "coding"
	| "qa"
	| "needs_you"
	| "completed"
	| "failed";

/** A target repository in the orchestration */
export interface RepoTarget {
	id: string;
	repo: string; // display name (the repo's project name)
	displayName: string;
	localPath: string;
}

/** Dependency type between repos */
export type RepoDependencyType =
	| "package"
	| "api"
	| "shared_types"
	| "database"
	| "event"
	| "monorepo_internal";

/** A dependency edge between two repos */
export interface RepoDependencyEdge {
	source: string; // repo that depends on target
	target: string; // repo being depended upon
	type: RepoDependencyType;
	details?: string;
}

/** A detected breaking change between repos */
export interface BreakingChange {
	sourceRepo: string;
	targetRepo: string;
	changeType: string;
	description: string;
	severity: "warning" | "error";
	filePath: string;
	suggestion: string;
}

/** Execution state for a single repo in the orchestration */
export interface RepoExecutionState {
	repo: string;
	status: RepoExecutionStatus;
	/** The WorkPilot project that holds the repo's task. */
	projectId?: string;
	/** The repo's Kanban task, once created. */
	taskId?: string;
	prUrl?: string;
	branchName?: string;
	progress: number; // 0-100
}

/** The dependency graph structure */
export interface RepoDependencyGraph {
	nodes: string[];
	edges: RepoDependencyEdge[];
}

/** Full orchestration state */
export interface MultiRepoOrchestration {
	id: string;
	/** The project the orchestration was created from. */
	projectId: string;
	taskDescription: string;
	status: MultiRepoStatus;
	/** Why the run stopped or what it waits for, as a `multiRepo:` i18n key. */
	statusKey?: string;
	/** The repo the status is about, when there is one. */
	statusRepo?: string;
	/** Whether this app instance is driving it right now. */
	running: boolean;
	repos: RepoTarget[];
	dependencyGraph: RepoDependencyGraph;
	executionOrder: string[];
	repoStates: RepoExecutionState[];
	breakingChanges: BreakingChange[];
	overallProgress: number; // 0-100
	createdAt: string;
	updatedAt: string;
}

/** Configuration for creating a new multi-repo orchestration */
export interface MultiRepoCreateConfig {
	/** Absolute paths: registered projects or folders picked in a dialog. */
	repos: Array<{ localPath: string }>;
	taskDescription: string;
}
