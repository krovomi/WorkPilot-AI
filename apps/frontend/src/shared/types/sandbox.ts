/**
 * Agent Simulation Sandbox — Types for dry-run simulation.
 *
 * One result shape for the two modes of the sandbox page:
 * - `changes`: the uncommitted changes of the working tree (git diff HEAD);
 * - `plan`: a rehearsal of a spec's implementation plan over the files of a
 *   git ref (apps/backend/simulation), free and offline.
 */

export type SandboxMode = "changes" | "plan";

export type FindingLevel = "error" | "warning" | "info";

/** A rehearsal finding: `code` is translated by the page (sandbox:findings.*). */
export interface SimulationFinding {
	level: FindingLevel;
	code: string;
	params: Record<string, string | number>;
	/** English fallback, for a code this version of the app does not know. */
	message: string;
}

export interface PhaseCostEstimate {
	phase: string;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	iterations: number;
	estimated_cost_usd: number;
}

export interface CostEstimate {
	spec_id: string;
	total_cost_usd: number;
	confidence: "high" | "medium" | "low";
	phases: PhaseCostEstimate[];
	warnings: string[];
}

export type SandboxPhase =
	| "idle"
	| "creating_worktree"
	| "running_simulation"
	| "analyzing_diff"
	| "awaiting_approval"
	| "complete"
	| "error";

export type StepStatus = "success" | "warning" | "error" | "skipped";

export type ApprovalDecision = "approved" | "rejected" | "partial";

export interface MockResponse {
	url: string;
	method: string;
	statusCode: number;
	body: string;
	strategy: "schema_based" | "llm_generated" | "static" | "error";
}

export interface SimulationStep {
	index: number;
	description: string;
	status: StepStatus;
	durationMs: number;
	tokensUsed: number;
	mockApiCalls: MockResponse[];
	warnings: string[];
	errors: string[];
	/** Plan mode only. */
	subtaskId?: string;
	phase?: string;
	findings?: SimulationFinding[];
	filesCreated?: string[];
	filesModified?: string[];
}

export interface FileDiff {
	filePath: string;
	changeType: "added" | "modified" | "deleted" | "renamed";
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	/** Plan mode: the subtask that first creates or modifies the file. */
	subtaskId?: string;
}

export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	content: string;
}

export interface SimulationResult {
	id: string;
	specId: string;
	phase: SandboxPhase;
	steps: SimulationStep[];
	diffs: FileDiff[];
	totalTokensUsed: number;
	estimatedCostUsd: number;
	estimatedRealCostUsd: number;
	durationMs: number;
	successCount: number;
	warningCount: number;
	errorCount: number;
	createdAt: string;
	/** Absent on results of older backends: they only knew `changes`. */
	mode?: SandboxMode;
	/** Plan mode only. */
	baseRef?: string;
	planFindings?: SimulationFinding[];
	contracts?: string[];
	partial?: boolean;
	costEstimate?: CostEstimate | null;
	verdict?: "ready" | "review" | "blocked";
	infoCount?: number;
}

export interface ApprovalResult {
	decision: ApprovalDecision;
	approvedFiles: string[];
	rejectedFiles: string[];
	comment: string;
}
