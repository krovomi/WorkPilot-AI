/**
 * How "How you compare" writes its figures, on screen and in the team
 * report alike: every figure is per spec and lower is better.
 */

import type { CompareMetric } from "@shared/types/build-compare";
import type { Tone } from "../charter";

/** The key of each metric's label under `analytics:compare.metrics`. */
export const METRIC_KEYS: Record<CompareMetric, string> = {
	minutes: "minutes",
	cost: "cost",
	qa_iterations: "qaIterations",
	agents: "agents",
};

/** A metric's value as the person reads it; a dash when nothing recorded it. */
export function formatMetric(metric: CompareMetric, value: number | null): string {
	if (value === null) return "—";
	if (metric === "cost") return `$${value.toFixed(2)}`;
	if (metric === "minutes") {
		return value < 60 ? `${value.toFixed(0)} min` : `${(value / 60).toFixed(1)} h`;
	}
	return value.toFixed(1).replace(/\.0$/, "");
}

/** Lower is better for every metric: a fall is good news. */
export function trendTone(value: number | null): Tone {
	if (value === null || Math.abs(value) < 5) return "muted";
	return value < 0 ? "green" : "amber";
}

export function formatTrend(value: number | null): string {
	if (value === null) return "—";
	return `${value > 0 ? "+" : ""}${value.toFixed(0)}%`;
}
