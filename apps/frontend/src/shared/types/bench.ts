/**
 * Repo bench — finished cards replayed from the commit before them, once per
 * engine, and judged by the tests they landed with (apps/backend/bench/).
 *
 * The manifest is written by `runners/bench_runner.py` only; these types are
 * what the main process and the view read from it.
 */

export interface BenchEngine {
	provider: string;
	model: string;
	effort: string;
}

export interface BenchSuite {
	kind: "pytest" | "vitest" | "jest" | "go" | "dotnet" | "custom" | string;
	cwd: string;
	report: string;
	files: string[];
}

export type BenchCaseStatus =
	| "candidate"
	| "refused"
	| "calibrating"
	| "excluded"
	| "ready";

export interface BenchCase {
	caseId: string;
	status: BenchCaseStatus;
	/** Why the card is not a case: a code the view translates… */
	reasonCode?: string;
	/** …and the backend's detail, in English (a file, a tool's message). */
	reason?: string;
	target?: string;
	base?: string;
	source?: "merge" | "pr" | "given";
	note?: string;
	tests?: string[];
	deletedTests?: string[];
	runnable?: string[];
	suites?: BenchSuite[];
	f2p?: string[];
	p2p?: string[];
}

export type BenchBuildState = "pending" | "judged" | "skipped";

export interface BenchBuild {
	id: string;
	caseId: string;
	engineId: string;
	taskId: string;
	copy: string;
	state: BenchBuildState;
	reasonCode?: string;
	reason?: string;
	exitCode?: number | null;
	durationS?: number | null;
	costUsd?: number | null;
	resolved?: boolean;
	f2pPassed?: number;
	p2pPassed?: number;
	resetTests?: string[];
	judgeErrors?: string[];
}

export interface BenchManifest {
	runId: string;
	createdAt: string;
	endedAt?: string;
	phase: "calibrating" | "running" | "done" | "discarded";
	engines: Array<BenchEngine & { id: string }>;
	cases: BenchCase[];
	builds: BenchBuild[];
}

export interface BenchTableRow {
	provider: string;
	model: string;
	effort: string;
	judged: number;
	resolved: number;
	rate: number;
	cases: number;
	runs: number;
	f2pRate: number | null;
	avgCostUsd: number | null;
	avgDurationS: number | null;
}

/** A finished card of the project, and whether it can be a case. */
export interface BenchCandidate {
	specId: string;
	title: string;
	case: BenchCase;
}

export interface BenchStatus {
	/** The run in progress in this app session, if any. */
	activeRunId: string | null;
	busy?: "preparing" | "discarding";
	error?: string;
	/** Builds whose process runs now (their task ids). */
	running: string[];
	/** Builds waiting for a slot. */
	queued: number;
	concurrency: number;
	runs: Array<BenchManifest & { stale?: boolean }>;
	table: BenchTableRow[];
}
