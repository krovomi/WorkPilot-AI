/**
 * A server project's workspace views (`shared_features/workspace.py`) and
 * analyses (`shared_features/analyses.py`), as the server answers.
 */

export interface DashboardSnapshot {
	tasks_by_status: Record<string, number>;
	qa_first_pass_rate: number;
	qa_avg_score: number;
	total_tokens: number;
	tokens_by_provider: Record<string, number>;
	total_cost: number;
	cost_by_model: Record<string, number>;
	merge_auto_count: number;
	merge_manual_count: number;
}

export interface CostSummary {
	total_cost: number;
	cost_by_provider: Record<string, number>;
	cost_by_model: Record<string, number>;
	total_tokens: number;
	tokens_input: number;
	tokens_output: number;
	period_days: number;
	daily_avg: number;
	trend_pct: number | null;
}

export interface WorkSession {
	id: string;
	kind: "run" | "job";
	spec: string | null;
	phase: string;
	status: string;
	model: string | null;
	started_by: string | null;
	started_at: string | null;
	finished_at: string | null;
	duration_seconds: number | null;
	tokens: number | null;
	cost: number | null;
	error: string | null;
}

export const ANALYSES = ["accessibility", "i18n", "doc-drift", "flaky-tests", "tech-debt"] as const;
export type AnalysisKind = (typeof ANALYSES)[number];

/** A saved analysis report file: the runner's report and who ran it, when. */
export interface SavedReport {
	analysis: string;
	report: unknown;
	finished_at: string | null;
	run_by: string | null;
}
