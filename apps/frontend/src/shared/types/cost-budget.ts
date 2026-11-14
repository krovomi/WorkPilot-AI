/**
 * The project's cost budget (`.workpilot/cost-budget.json`) and where it
 * stands. Written by the Costs page, read by the backend before every agent
 * session (`apps/backend/cost_budget/`).
 */

export type BudgetPeriod = "monthly" | "weekly" | "total";
export type BudgetAction = "pause" | "warn";
export type BudgetLevel = "ok" | "warning" | "critical" | "exceeded";

export interface CostBudgetConfig {
	/** USD per period for the whole project; 0 = none. */
	limit: number;
	period: BudgetPeriod;
	warning_threshold: number;
	critical_threshold: number;
	/** USD per task; 0 = none. A task's own `budgetUsd` wins. */
	task_limit: number;
	on_exceed: BudgetAction;
	/** Step the model down past the thresholds. */
	degrade: boolean;
	/** Pause a task that spends this many times its average per completed subtask without completing one; 0 = off. */
	stall_multiplier: number;
}

export interface CostBudgetStatus {
	config: CostBudgetConfig;
	/** Whether the project set any budget (project or per task). */
	configured: boolean;
	spent: number;
	/** False when a session had tokens but no price: `spent` is a floor. */
	complete: boolean;
	remaining: number;
	utilizationPct: number;
	level: BudgetLevel;
	forecastEndOfPeriod: number;
	/** The tasks past the warning threshold of the per-task limit. */
	tasksOverWarning: { specId: string; spent: number }[];
}

/** What the backend records on a task it paused for its budget (`pause_state.json`). */
export interface BudgetPauseDetail {
	scope: "task" | "project" | "stall";
	spentUsd: number;
	limitUsd: number;
	percent?: number;
	complete?: boolean;
	period?: string;
	completedSubtasks?: number;
	totalSubtasks?: number;
}
