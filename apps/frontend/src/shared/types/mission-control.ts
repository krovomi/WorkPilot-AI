/**
 * Mission Control: several agents at once, each on its own provider and model.
 * The state lives in the local backend (`apps/backend/mission_control/`); the
 * main process proxies it and runs each agent's model call
 * (`main/mission-control/`).
 */

export interface MissionControlTokenUsage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	estimated_cost_usd: number;
}

export type MissionControlAgentStatus =
	| "idle"
	| "running"
	| "paused"
	| "completed"
	| "error"
	| "waiting";

export interface MissionControlAgent {
	id: string;
	name: string;
	role: string;
	status: MissionControlAgentStatus;
	provider: string;
	model: string;
	model_label: string;
	current_task: string;
	current_step: string;
	progress: number;
	tokens: MissionControlTokenUsage;
	active_files: string[];
	current_thinking: string;
	last_tool_call: string;
	last_tool_input: string;
	decision_path: string[];
	started_at: number | null;
	completed_at: number | null;
	elapsed_seconds: number;
	streaming_session_id: string | null;
	/** The model's answer to the current task, as it streams in. */
	output: string;
	error_message: string;
	/** `auto` for an agent of a composed crew (#344). */
	origin?: "manual" | "auto";
	/** The tokens its composition expected; 0 for a manual agent. */
	estimated_tokens?: number;
	/** How many times live rebalancing moved it on its current task. */
	rebalances?: number;
	/** Its answer, or its decision tree, repeats itself: the run is stopped and rebalanced. */
	loop_detected?: boolean;
	/** A helper started beside a stuck agent: the agent it helps, and its name. */
	helper_of?: string;
	helper_of_name?: string;
	/** On a stuck agent, the helper started for its current task. */
	helper_id?: string;
}

export interface MissionControlDecisionNode {
	id: string;
	parent_id: string | null;
	node_type:
		| "root"
		| "thinking"
		| "tool_call"
		| "decision"
		| "result"
		| "error"
		| "branch";
	status: "active" | "completed" | "failed" | "skipped";
	label: string;
	description: string;
	timestamp: number;
	tool_name: string;
	tool_input: string;
	tool_output: string;
	options_considered: string[];
	chosen_option: string;
	reasoning: string;
	children: string[];
	duration_ms: number;
}

export interface MissionControlDecisionTree {
	agent_id: string;
	root_id: string | null;
	current_node_id: string | null;
	node_count: number;
	nodes: Record<string, MissionControlDecisionNode>;
}

export interface MissionControlSession {
	session_id: string;
	is_active: boolean;
	created_at: number;
	agent_count: number;
	running_count: number;
	total_tokens: number;
	total_cost_usd: number;
	elapsed_seconds: number;
	/** The crew's providers and budget, and the rebalancing switch (#344). */
	plan?: MissionControlPlan;
	over_budget?: boolean;
	rebalance_count?: number;
}

export interface MissionControlPlan {
	/** Where a rebalanced agent may go, in the person's order. */
	providers: string[];
	budget_usd: number | null;
	budget_tokens: number | null;
	auto_rebalance: boolean;
}

/** A crew's providers and budget (replaced together), or the switch alone. */
export interface MissionControlPlanRequest {
	providers?: string[];
	budgetUsd?: number;
	budgetTokens?: number;
	autoRebalance?: boolean;
}

/** The issue's measures over the sessions this person ran (`metrics.py`). */
export interface MissionControlMetrics {
	sessions: number;
	auto_share: number | null;
	avg_tokens_auto: number | null;
	avg_tokens_manual: number | null;
	delta_tokens: number | null;
	estimate_ratio: number | null;
	rebalances_per_session: number | null;
	budget_sessions: number;
	overrun_rate: number | null;
}

/** What the backend logs (`mission_control/orchestrator.py`, `_log_event`). */
export type MissionControlEventType =
	| "agent_created"
	| "agent_removed"
	| "agent_started"
	| "agent_paused"
	| "agent_resumed"
	| "agent_stopped"
	| "agent_config_updated"
	| "agent_completed"
	| "agent_failed"
	| "agent_rebalanced"
	| "agent_rebalance_skipped"
	| "agent_loop_detected";

/** Why a run was rebalanced, what was done, and why nothing was. */
export type MissionControlRebalanceReason = "loop" | "rate_limited" | "provider_failed" | "failed";
export type MissionControlRebalanceAction = "retry_profile" | "reroute" | "escalate" | "helper";
/** Where a loop was read: the answer, or the steps of the decision tree. */
export type MissionControlLoopSource = "answer" | "steps";
export type MissionControlRebalanceSkip = "limit" | "over_budget" | "no_alternative" | "disabled";

export interface MissionControlEvent {
	type: MissionControlEventType;
	timestamp: number;
	/** Every event names its agent; a start carries its task, a failure its error. */
	data: {
		agent_id: string;
		task?: string;
		error?: string;
		reason?: MissionControlRebalanceReason;
		action?: MissionControlRebalanceAction;
		skipped?: MissionControlRebalanceSkip;
		/** A rebalancing's models, as the card names them. */
		from?: string;
		to?: string;
		source?: MissionControlLoopSource;
	} & Record<string, unknown>;
}

export interface MissionControlState {
	session: MissionControlSession;
	agents: MissionControlAgent[];
	decision_trees: Record<string, MissionControlDecisionTree>;
	recent_events: MissionControlEvent[];
}

export interface MissionControlNewAgent {
	name: string;
	role: string;
	provider: string;
	model: string;
	modelLabel: string;
	/** An agent of a composed crew, with the tokens its composition expected. */
	origin?: "manual" | "auto";
	estimatedTokens?: number;
}

export interface MissionControlStartRequest {
	agentId: string;
	/** Empty: run the agent's last task again. */
	task: string;
	/** The project a CLI provider runs in; the model call is text only. */
	projectId?: string;
}

/** The ready-made crews; `auto` lets the work decide (#344). */
export const MISSION_CONTROL_TEMPLATES = [
	"bug_fix",
	"new_feature",
	"refactor_module",
	"incident_response",
] as const;
export type MissionControlTemplate = (typeof MISSION_CONTROL_TEMPLATES)[number];

export interface MissionControlCompositionRequest {
	/** A description of the work, the person's own words. */
	prompt?: string;
	/** The project whose stack is read; a spec is read only within it. */
	projectId?: string;
	specId?: string;
	template?: MissionControlTemplate;
	/** In order of preference; a role goes to the first that serves it. */
	providers: string[];
	budgetUsd?: number;
	budgetTokens?: number;
	/** Ask a fast model of the first provider for a second opinion. */
	refine?: boolean;
}

export interface MissionControlPlannedAgent {
	key: string;
	role: string;
	critical: boolean;
	optional: boolean;
	provider: string;
	/** Empty: the provider's own default (a CLI agent). */
	model: string;
	model_label: string;
	tier: "flagship" | "standard" | "fast" | "local" | "provider_default";
	input_tokens: number;
	output_tokens: number;
	/** null: the catalog has no price for this model. */
	cost_usd: number | null;
	flat_rate: boolean;
	tool_use: boolean | null;
	context_window: number;
}

export interface MissionControlCrew {
	agents: MissionControlPlannedAgent[];
	cost_usd: number;
	tokens: number;
	unpriced: number;
	/** Expected quality relative to the full crew, 0 to 1. */
	quality: number;
}

export interface MissionControlCompositionWarning {
	code: string;
	params: Record<string, string>;
}

export type MissionControlCompositionChange =
	| { key: string; role: string; kind: "dropped" }
	| {
			key: string;
			role: string;
			kind: "model";
			from: MissionControlPlannedAgent;
			to: MissionControlPlannedAgent;
	  };

export interface MissionControlComposition {
	status: "ok" | "degraded" | "refused";
	template: string;
	template_source: "chosen" | "model" | "fallback" | "kind";
	complexity: "small" | "medium" | "large";
	signals: {
		words: number;
		spec_tokens: number;
		touched_files: number;
		domains: string[];
		has_test_suite: boolean;
		languages: string[];
		kind: string;
		has_spec: boolean;
	};
	hinted: boolean;
	/** Roles whose token estimate past sessions calibrated. */
	calibrated?: string[];
	warnings: MissionControlCompositionWarning[];
	budget: { usd: number | null; tokens: number | null };
	full: MissionControlCrew;
	/** The crew to create; null when the budget is refused. */
	proposed: MissionControlCrew | null;
	/** The smallest crew, when even it does not fit the budget. */
	minimum: MissionControlCrew | null;
	steps: string[];
	changes: MissionControlCompositionChange[];
}
