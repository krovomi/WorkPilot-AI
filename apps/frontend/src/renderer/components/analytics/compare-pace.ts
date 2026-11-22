/**
 * The project's own trend read against its peers' (« your cost per spec fell
 * 18%, the median fell 4%: you are improving faster »), and the segment it
 * is moving between, worded alike on screen and in the team report.
 *
 * Each figure is set against the narrowest group that has a trend for it:
 * same stack and size, then same stack, same team size, all projects.
 */

import {
	type BuildComparison,
	COMPARE_GROUPS,
	COMPARE_METRICS,
	type CompareGroupName,
	type CompareMetric,
} from "@shared/types/build-compare";
import type { TFunction } from "i18next";
import { formatTrend, improvement, METRIC_KEYS } from "./compare-format";

/** Below this gap, in points of percent, two trends go at the same pace. */
const SAME_PACE = 5;

export interface PaceLine {
	metric: CompareMetric;
	own: number;
	group: CompareGroupName;
	groupTrend: number;
	verdict: "faster" | "slower" | "same";
}

export function paceLines(comparison: BuildComparison): PaceLine[] {
	const lines: PaceLine[] = [];
	for (const metric of COMPARE_METRICS) {
		const own = comparison.trend[metric];
		if (own === null) continue;
		const group = COMPARE_GROUPS.find((name) => (comparison.groups[name].trend?.[metric] ?? null) !== null);
		if (!group) continue;
		const groupTrend = comparison.groups[group].trend?.[metric] as number;
		const gap = improvement(metric, own) - improvement(metric, groupTrend);
		const verdict = Math.abs(gap) < SAME_PACE ? "same" : gap > 0 ? "faster" : "slower";
		lines.push({ metric, own, group, groupTrend, verdict });
	}
	return lines;
}

/** One pace line in the app's language. */
export function paceSentence(line: PaceLine, t: TFunction): string {
	return t(`analytics:compare.pace.${line.verdict}`, {
		metric: t(`analytics:compare.metrics.${METRIC_KEYS[line.metric]}`),
		own: formatTrend(line.own),
		group: formatTrend(line.groupTrend),
		groupName: t(`analytics:compare.groups.${line.group}`),
	});
}

/** The segments the project is moving between, one sentence each. */
export function moveSentences(comparison: BuildComparison, t: TFunction): string[] {
	const { segment, window_days: days } = comparison;
	const moves: [string, string | null, string][] = [
		["sizes", segment.size_from, segment.size],
		["teams", segment.team_from, segment.team],
	];
	return moves
		.filter((move): move is [string, string, string] => move[1] !== null)
		.map(([axis, from, to]) =>
			t("analytics:compare.moving", {
				days,
				from: t(`analytics:compare.${axis}.${from}`, { defaultValue: from }),
				to: t(`analytics:compare.${axis}.${to}`, { defaultValue: to }),
			}),
		);
}
