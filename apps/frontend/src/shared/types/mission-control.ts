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
}

export interface MissionControlEvent {
	type: string;
	timestamp: number;
	data: Record<string, unknown>;
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
}

export interface MissionControlStartRequest {
	agentId: string;
	/** Empty: run the agent's last task again. */
	task: string;
	/** The project a CLI provider runs in; the model call is text only. */
	projectId?: string;
}
