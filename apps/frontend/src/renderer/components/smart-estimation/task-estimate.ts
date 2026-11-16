/**
 * What the dialog keeps on a task from an estimation run, so the board shows
 * it and the calibration loop can read it back at merge
 * (`apps/backend/estimation_calibration/capture.py`). No duration.
 */

import type {
	CalibrationMetric,
	SmartEstimationResult,
	TaskSmartEstimate,
} from "../../../shared/types/smart-estimation";

export const CALIBRATION_METRICS: readonly CalibrationMetric[] = [
	"cost_usd",
	"tokens",
	"qa_iterations",
	"files",
];

/** The generic and shown figure of each metric the run calibrated. */
export function calibrationInputs(
	result: SmartEstimationResult,
): TaskSmartEstimate["calibrationInputs"] {
	const metrics = result.calibration?.metrics;
	if (!metrics) return undefined;
	const inputs: NonNullable<TaskSmartEstimate["calibrationInputs"]> = {};
	for (const key of CALIBRATION_METRICS) {
		const row = metrics[key];
		if (row && row.base !== null && row.value !== null) {
			inputs[key] = { base: row.base, value: row.value };
		}
	}
	return inputs;
}

/** The estimate kept on the task for *result*. */
export function taskEstimateFrom(
	result: SmartEstimationResult,
	at: string = new Date().toISOString(),
): TaskSmartEstimate {
	return {
		complexityScore: result.complexity_score,
		confidenceLevel: result.confidence_level,
		riskFactors: result.risk_factors,
		qaIterations: result.estimated_qa_iterations,
		at,
		category: result.category,
		calibrationInputs: calibrationInputs(result),
	};
}
