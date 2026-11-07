/**
 * The workspace views (dashboard, analytics, costs, session history): what
 * they read, from the project folder of this computer
 * (`ipc-handlers/cost-handlers.ts`) or, for a server project, from the server
 * (`main/server-workspace.ts`).
 */

/** The last thirty days of spend, against the thirty before. */
export interface CostSummary {
	total_cost: number;
	cost_by_provider: Record<string, number>;
	cost_by_model: Record<string, number>;
	total_tokens: number;
	tokens_input: number;
	tokens_output: number;
	period_days: number;
	daily_avg: number;
	trend_pct: number;
}

export interface DashboardSnapshot {
	tasks_by_status: Record<string, number>;
	avg_completion_by_complexity: Record<string, number>;
	qa_first_pass_rate: number;
	qa_avg_score: number;
	total_tokens: number;
	tokens_by_provider: Record<string, number>;
	total_cost: number;
	cost_by_model: Record<string, number>;
	merge_auto_count: number;
	merge_manual_count: number;
}

/** A phase of a session, with what its agents spent. */
export interface WorkspaceSessionPhase {
	name: string;
	status: string;
	duration_seconds?: number;
	tokens?: number;
}

/** An agent session, as the Session History view lists it. */
export interface WorkspaceSession {
	session_id: string;
	task_id?: string;
	task_title?: string;
	status: string;
	started_at: string;
	ended_at?: string;
	duration_seconds?: number;
	tokens_used?: number;
	cost?: number;
	files_changed?: number;
	error?: string;
	phases?: WorkspaceSessionPhase[];
	/** A server project's session: a run of a card's phase, or a feature's job. */
	kind?: "run" | "job";
	/** The card's phase (`build`, `qa`…) or the job's feature (`roadmap`…). */
	phase?: string;
	/** Who started it, by name. */
	started_by?: string;
}
