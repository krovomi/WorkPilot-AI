/**
 * Smart estimation types.
 *
 * Shared between the preload bridge and the renderer store so both sides
 * describe the same payload — the runner is the single producer.
 *
 * No duration field appears here on purpose. `smart_estimation_service`
 * computes one for its own scoring, but `smart_estimation_runner` strips it
 * before emitting: the product rule is to never give a duration prediction,
 * and a field that never crosses the boundary cannot leak into the UI later.
 */

/** One historical build the estimator considered comparable. */
export interface SimilarTaskRef {
	build_id: string;
	spec_name: string;
	similarity_score: number;
	complexity_score: number;
	qa_iterations?: number;
	success_rate?: number;
	tokens_used?: number;
	cost_usd?: number;
	status: string;
}

/** Structured result emitted on `smart-estimation-complete`. */
export interface SmartEstimationResult {
	/** Relative complexity, 1-13, story-point style. */
	complexity_score: number;
	/** 0-1 confidence in the score, driven by how much history backs it. */
	confidence_level: number;
	reasoning: string[];
	similar_tasks: SimilarTaskRef[];
	risk_factors: string[];
	estimated_qa_iterations?: number;
	token_cost_estimate?: number;
	recommendations: string[];
}

/**
 * Progress event emitted on `smart-estimation-event`. The runner sends
 * `{type, data, timestamp}`; `data.status` carries the human-readable step.
 */
export interface SmartEstimationEvent {
	type: "start" | "progress" | "complete" | "error" | string;
	data: { status?: string; error?: string } & Record<string, unknown>;
	timestamp: string;
}

/**
 * The slice of a result worth keeping on the task itself, so the card can show
 * it without re-running the analysis.
 */
export interface TaskSmartEstimate {
	complexityScore: number;
	confidenceLevel: number;
	riskFactors: string[];
	qaIterations?: number;
	/** ISO timestamp of the run that produced it. */
	at: string;
}
