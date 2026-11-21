/**
 * The governance sections of `workpilot.policy.yaml` and the policy's audit
 * trail, as the backend reports them (`runners/guardrails_runner.py governance |
 * audit`, `security/governance_policy.py`, `security/policy_audit.py`).
 */

/** What a line of the audit trail says the policy decided. A closed list. */
export type PolicyDecision =
	| "deny"
	| "review"
	| "approved"
	| "warn"
	| "outside_hours"
	| "budget_exceeded"
	| "invalid_policy"
	| "tool_loop";

export const POLICY_DECISIONS: readonly PolicyDecision[] = [
	"deny",
	"review",
	"approved",
	"warn",
	"outside_hours",
	"budget_exceeded",
	"invalid_policy",
	"tool_loop",
];

/** One decision of the policy (`.workpilot/policy-audit.jsonl`). */
export interface PolicyAuditEvent {
	id: string;
	at: string;
	user: string | null;
	task: string | null;
	tool: string | null;
	targetKind: "file" | "command" | null;
	target: string | null;
	decision: PolicyDecision;
	rules: string[];
	reason: string | null;
	provider: string | null;
	model: string | null;
}

export interface GovernanceSchedule {
	timezone: string;
	allowedHours: string[];
	days: string[];
	openNow: boolean;
	localTime: string | null;
}

export interface GovernanceSections {
	source: string;
	schedule: GovernanceSchedule | null;
	files: { forbidden: string[]; requiresReview: string[] };
	budget: { maxTokensPerHour: number | null; maxTokensPerTask: number | null } | null;
	/** `loop_detection`: identical tool calls before the circuit breaker trips. */
	loopDetection?: { maxSameToolCall: number } | null;
}

/** The audit trail's counts: agents stopped in the last day, breaker trips in the week. */
export interface GovernanceMetrics {
	blocked24h: number;
	breakerTrips7d: number;
}

/** What the read-only governance panel shows. */
export interface GovernanceReport {
	/** `null` when `workpilot.policy.yaml` has no schedule, files or budget, or is invalid. */
	governance: GovernanceSections | null;
	/** Why the policy is refused; while there are any, no write or command runs. */
	errors: string[];
	sources: Array<{ layer: string; path: string; rules: number }>;
	tokensLastHour: number;
	/** The last decisions, newest first. */
	events: PolicyAuditEvent[];
	metrics: GovernanceMetrics;
}

export type AuditExportFormat = "csv" | "json";

/** Where the export went, or `null` when the person closed the dialog. */
export type AuditExportResult = { filePath: string; count: number } | null;

/** What the policy watch wrote in `pause_state.json` (`agents/policy_watch.py`). */
export interface PolicyPauseDetail {
	reason: "policy_hours" | "policy_budget" | "policy_invalid";
	timezone?: string;
	allowedHours?: string[];
	tokensLastHour?: number;
	maxTokensPerHour?: number;
	/** `budget.max_tokens_per_task`: what this task's sessions spent, all along. */
	tokensThisTask?: number;
	maxTokensPerTask?: number;
	/** `policy_invalid`: how many errors the policy has (the panel lists them). */
	errorCount?: number;
}
