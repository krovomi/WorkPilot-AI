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

/**
 * The categories a spec is calibrated in. Closed list, the same as
 * `estimation_calibration/categories.py`; the main process and the runner
 * both refuse anything else.
 */
export const ESTIMATION_CATEGORIES = [
	"bug_fix",
	"infra",
	"frontend",
	"backend",
	"feature",
] as const;
export type EstimationCategory = (typeof ESTIMATION_CATEGORIES)[number];

/** What the calibration loop compares with the actuals at merge. No duration. */
export type CalibrationMetric = "cost_usd" | "tokens" | "qa_iterations" | "files";

/** One metric of the estimate: the generic figure and the calibrated one. */
export interface CalibratedMetric {
	base: number | null;
	value: number | null;
	/** 20th-80th percentile of past ratios applied to `base`. */
	low: number | null;
	high: number | null;
	factor: number;
	/** Which history the factor comes from. */
	scope: "category" | "repo" | "none";
	samples: number;
	outliers: number;
	confidence: number | null;
}

export interface EstimationCalibration {
	status: "calibrated" | "insufficient_history";
	category: EstimationCategory;
	samples: number;
	min_samples: number;
	reset_at: string | null;
	metrics: Record<CalibrationMetric, CalibratedMetric>;
	/** The complexity score moved by the person's past adjustments. */
	complexity: {
		base: number;
		value: number;
		bias: number;
		scope: "category" | "repo" | "none";
		adjustments: number;
	};
	red_flags: Array<{
		metric: CalibrationMetric;
		factor: number;
		scope: "category" | "repo";
	}>;
	providers: Array<{
		provider: string;
		samples: number;
		cost_ratio: number | null;
		tokens_ratio: number | null;
	}>;
	quality: {
		mape: Record<CalibrationMetric, number | null>;
		acceptance_rate: number | null;
		mean_interval_width: number | null;
		outliers_excluded: number;
	};
}

/** One dimension of the estimate; `uncertain` when no signal backs it. */
export interface EstimationDimension {
	key: "algorithmic" | "integration" | "conflict_risk" | "test_effort";
	level: "low" | "medium" | "high";
	signals: string[];
	uncertain: boolean;
}

/** An "Adjust estimate": the person's own score against the estimator's. */
export interface CalibrationAdjustRequest {
	projectId: string;
	category: EstimationCategory;
	baseScore: number;
	adjustedScore: number;
}

/** What the calibration runner answers after a write. */
export interface CalibrationSummary {
	samples: number;
	adjustments: number;
	reset_at: string | null;
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
	estimated_tokens?: number;
	estimated_files?: number;
	recommendations: string[];
	category?: EstimationCategory;
	dimensions?: EstimationDimension[];
	calibration?: EstimationCalibration;
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
	category?: EstimationCategory;
	/**
	 * The generic and the shown figure of each metric, read back at merge by
	 * `estimation_calibration/capture.py` to compare with the actuals.
	 */
	calibrationInputs?: Partial<
		Record<CalibrationMetric, { base: number; value: number }>
	>;
	/** The person's own complexity score, when they adjusted it. */
	adjustedScore?: number;
}
