/**
 * Types shared by the prompt optimizer's three processes: the main-process
 * service, the preload bridge and the renderer store.
 */

export type PromptOptimizerAgentType =
	| "general"
	| "analysis"
	| "coding"
	| "verification";

/** Structured result of `prompt_optimizer_runner.py`. */
export interface PromptOptimizerResult {
	optimized: string;
	changes: string[];
	reasoning: string;
}

/**
 * Phase codes the runner reports. Codes, not sentences: the renderer
 * translates them (`promptOptimizer:status.<code>`).
 */
export type PromptOptimizerStatus = "context" | "generating" | "parsing";

/**
 * A failure, coded so the renderer can say it in the user's language.
 * `message` is the technical detail (redacted by the backend), shown
 * underneath. Codes come from the runner (`core.error_details`: `auth`,
 * `rate_limit`, `quota`, `network`, `timeout`, `provider_unavailable`,
 * `empty_response`…) or from the main process (`runner_missing`,
 * `python_missing`, `project_not_found`, `spawn_failed`, `process_failed`).
 */
export interface PromptOptimizerError {
	code: string;
	message: string;
}
