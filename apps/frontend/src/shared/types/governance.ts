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
	/**
	 * Who let an `approved` call through. On a server: the account, its id and
	 * its roles; on this computer alone: the local user, "not verified".
	 * Absent from a report older than the field.
	 */
	approvedBy?: string | null;
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
	files: {
		forbidden: string[];
		requiresReview: string[];
		/** `files.reviewers`: the server roles one of which approves a reviewed call. */
		reviewers?: string[];
	};
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

/** A call an agent of a server project waits on, until a person answers it. */
export interface GovernanceRequest {
	id: string;
	at: string;
	rules: string[];
	tool: string | null;
	targetKind: "file" | "command" | null;
	target: string | null;
	task: string | null;
	message: string | null;
}

/** A server project's governance (`shared_features/governance.py`). */
export interface ServerGovernanceReport extends GovernanceReport {
	/** The calls waiting for an approval, newest first. */
	pending: GovernanceRequest[];
	/** Agents running on the server: started by this person, and in all. */
	agents: { mine: number; project: number };
	/** What the server lets this person do; it checks again on each request. */
	may: { approve: boolean; stop: boolean; stopProject: boolean; export: boolean };
}

/** Whose agents the kill switch of a server project stops. */
export type ServerStopScope = "mine" | "project";

export interface ServerStopResult {
	stoppedRuns: number;
	stoppedJobs: number;
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
