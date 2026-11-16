/**
 * Self-Healing Codebase + Incident Responder Types
 *
 * Feature #3 (Tier S+) - Unified surveillance, detection and auto-correction.
 */

// ── Enums ──────────────────────────────────────────────────

export type IncidentMode = "cicd" | "production" | "proactive";

export type IncidentSeverity = "critical" | "high" | "medium" | "low" | "info";

export type HealingStatus =
	| "pending"
	| "analyzing"
	| "fixing"
	| "qa_running"
	| "pr_created"
	| "resolved"
	| "escalated"
	| "failed";

export type IncidentSource =
	| "git_push"
	| "ci_failure"
	| "sentry"
	| "datadog"
	| "cloudwatch"
	| "new_relic"
	| "pagerduty"
	| "proactive_scan";

// ── Core Models ────────────────────────────────────────────

export interface Incident {
	id: string;
	mode: IncidentMode;
	source: IncidentSource;
	severity: IncidentSeverity;
	title: string;
	description: string;
	status: HealingStatus;
	created_at: string;
	resolved_at?: string;
	source_data: Record<string, unknown>;
	root_cause?: string;
	affected_files: string[];
	regression_commit?: string;
	fix_branch?: string;
	fix_pr_url?: string;
	fix_worktree?: string;
	qa_result?: Record<string, unknown>;
	error_message?: string;
	stack_trace?: string;
}

export interface HealingStep {
	name: string;
	/** `skipped`: the pipeline names the step but did not run it; `detail` says why. */
	status: "pending" | "running" | "completed" | "failed" | "skipped";
	detail?: string;
	started_at?: string;
	completed_at?: string;
}

export interface HealingOperation {
	id: string;
	incident: Incident | null;
	started_at: string;
	completed_at?: string;
	steps: HealingStep[];
	duration_seconds?: number;
	success: boolean;
}

export interface FragilityReport {
	file_path: string;
	risk_score: number;
	cyclomatic_complexity: number;
	git_churn_count: number;
	test_coverage_percent: number;
	last_incident_days?: number;
	suggested_tests: string[];
}

// ── Risk trends (proactive mode, #370) ─────────────────────

export type RiskTrajectory =
	| "new"
	| "stable"
	| "slow_rise"
	| "fast_rise"
	| "improving";

export interface RiskPoint {
	day: string;
	risk: number;
}

export interface FileRiskTrend {
	file: string;
	trajectory: RiskTrajectory;
	/** Risk points per week over the window. */
	slope: number;
	acceleration: number;
	risk: number;
	start_risk: number;
	reset: boolean;
	entered_hot: boolean;
	complexity_change_pct: number;
	churn_start: number;
	churn_now: number;
	points: RiskPoint[];
}

export interface RiskCluster {
	directory: string;
	files: string[];
	rising: number;
	fast: number;
	total: number;
	share: number;
	mean_slope: number;
}

export interface RiskTrendReport {
	snapshots: number;
	window_days: number;
	files: number;
	counts: Record<RiskTrajectory, number>;
	hot: FileRiskTrend[];
	rising: FileRiskTrend[];
	improving: FileRiskTrend[];
	entered_hot: string[];
	clusters: RiskCluster[];
}

// ── Incident groups (production mode, #372) ────────────────

export interface IncidentGroup {
	sources: string[];
	report_count: number;
}

export interface SuspectCommit {
	sha: string;
	subject: string;
	committed_at: number;
	files: string[];
	score: number;
	since?: string;
}

/** Open production incidents whose most suspect commit is the same. */
export interface IncidentCluster {
	id: string;
	commit: string;
	subject: string;
	incident_ids: string[];
	severity: IncidentSeverity;
	occurrences: number;
	affected_users: number;
	sources: string[];
}

// ── Bisect (CI/CD mode, #375) ──────────────────────────────

export type BisectStatus =
	| "found"
	| "ambiguous"
	| "flaky"
	| "not_reproduced"
	| "good_fails"
	| "budget"
	| "unavailable";

export interface BisectStep {
	sha: string;
	outcome: "good" | "bad" | "skip";
	role: "bad-check" | "flaky-check" | "good-check" | "search";
	seconds: number;
	detail: string;
}

export interface BisectResult {
	status: BisectStatus;
	good: string;
	bad: string;
	first_bad: string;
	first_bad_subject: string;
	candidates: string[];
	steps: BisectStep[];
	tested: number;
	commits_in_range: number;
	command: string;
	narrowed: boolean;
	reason: string;
	cached: boolean;
}

export interface BisectTriggers {
	fired: boolean;
	reasons: Array<"trivial_diff" | "old_test" | "dependency_changed">;
	changed_lines: number | null;
	old_tests: string[];
	dependency_files: string[];
}

/** One line the bisect streams while it runs. */
export interface BisectProgressEvent {
	incidentId: string;
	step: BisectStep & { tested: number };
}

export interface BisectRequestResult {
	success: boolean;
	result?: BisectResult;
	error?: string;
}

// ── Configuration ──────────────────────────────────────────

export interface CICDConfig {
	enabled: boolean;
	watchBranches: string[];
	autoFixEnabled: boolean;
	autoCreatePR: boolean;
	/** Bisect when a trigger fires and a green commit is known (#375). */
	autoBisect?: boolean;
}

export interface ProductionConfig {
	enabled: boolean;
	connectedSources: IncidentSource[];
	autoAnalyze: boolean;
	autoFix: boolean;
	severityThreshold: IncidentSeverity;
}

export interface ProactiveConfig {
	enabled: boolean;
	scanFrequency: "daily" | "weekly" | "on_push";
	riskThreshold: number;
	autoGenerateTests: boolean;
}

// ── Dashboard ──────────────────────────────────────────────

export interface SelfHealingStats {
	totalIncidents: number;
	resolvedIncidents: number;
	activeIncidents: number;
	avgResolutionTime: number;
	autoFixRate: number;
}

export interface SelfHealingDashboardData {
	incidents: Incident[];
	activeOperations: HealingOperation[];
	fragilityReports: FragilityReport[];
	stats: SelfHealingStats;
	productionStatus: {
		connected_sources: string[];
		configs: Record<string, unknown>;
	};
	proactiveSummary: {
		scanned: boolean;
		files_at_risk: number;
		avg_risk: number;
		max_risk: number;
		top_files: Array<{ file: string; risk: number }>;
	};
	/** Absent when the dashboard came from the Node fallback (no history). */
	riskTrends?: RiskTrendReport;
	incidentClusters?: IncidentCluster[];
}

// ── IPC Payloads ───────────────────────────────────────────

export interface SelfHealingConfigUpdate {
	cicd?: Partial<CICDConfig>;
	production?: Partial<ProductionConfig>;
	proactive?: Partial<ProactiveConfig>;
}

export interface TriggerFixRequest {
	incidentId: string;
}

export interface ConnectSourceRequest {
	source: IncidentSource;
	serverUrl: string;
	apiKey?: string;
	projectId?: string;
	environment?: string;
}

export interface DisconnectSourceRequest {
	source: IncidentSource;
}
