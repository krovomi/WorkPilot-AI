/**
 * Numbers of the calibration panel, in the app's language: a cost in dollars,
 * tokens in compact notation, iterations and files with one decimal at most.
 */

import type { CalibrationMetric } from "../../../shared/types/smart-estimation";

export function formatMetric(
	metric: CalibrationMetric,
	value: number,
	language: string,
): string {
	if (metric === "cost_usd") {
		return new Intl.NumberFormat(language, {
			style: "currency",
			currency: "USD",
		}).format(value);
	}
	return new Intl.NumberFormat(language, {
		notation: metric === "tokens" ? "compact" : "standard",
		maximumFractionDigits: 1,
	}).format(value);
}

/** A ratio as a percentage, rounded: 0.724 → 72. */
export function percent(value: number): number {
	return Math.round(value * 100);
}
