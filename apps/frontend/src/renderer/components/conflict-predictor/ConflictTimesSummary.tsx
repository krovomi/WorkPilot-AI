/**
 * Resolution time of residual merge conflicts (#358, lot 4): over the last
 * `SPRINT_DAYS` days, how many conflicts the merge flow saw resolved and the
 * median time from the conflict to the merge that went through, plus the
 * conflicts still open. Two dates the main process recorded for each
 * conflict: a measured time, never an estimate.
 */

import { Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MergeConflictTimes } from "../../../shared/types/conflict-waves";
import { Notice } from "../charter";
import { formatPhaseDuration } from "../task-detail/TaskPhaseProgressBar";
import { SPRINT_DAYS } from "./WavesNotices";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The median of some numbers, or null when there is none. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface ConflictTimesFigures {
	/** Conflicts resolved within the window. */
	resolved: number;
	/** Their median time to resolve, in milliseconds; null when none was. */
	medianMs: number | null;
	/** Conflicts not resolved yet, whenever they appeared. */
	open: number;
}

export function conflictTimesFigures(times: MergeConflictTimes, now: number): ConflictTimesFigures {
	const durations = times.entries
		.filter((e) => e.resolvedAt !== null && now - Date.parse(e.resolvedAt) <= SPRINT_DAYS * DAY_MS)
		.map((e) => Date.parse(e.resolvedAt as string) - Date.parse(e.detectedAt));
	return {
		resolved: durations.length,
		medianMs: median(durations),
		open: times.entries.filter((e) => e.resolvedAt === null).length,
	};
}

export function ConflictTimesSummary({ times, now = Date.now() }: { times: MergeConflictTimes; now?: number }) {
	const { t, i18n } = useTranslation(["conflictPredictor"]);
	if (times.ignored) {
		return <p className="wp-meta">{t("conflictPredictor:waves.conflictTimes.ignored")}</p>;
	}
	const { resolved, medianMs, open } = conflictTimesFigures(times, now);
	if (resolved === 0 && open === 0) return null;
	return (
		<Notice tone="muted" icon={Timer} role="status">
			<span data-testid="merge-conflict-times">
				{medianMs === null
					? t("conflictPredictor:waves.conflictTimes.noneResolved", { days: SPRINT_DAYS })
					: t("conflictPredictor:waves.conflictTimes.resolved", {
							days: SPRINT_DAYS,
							count: resolved,
							median: formatPhaseDuration(medianMs, i18n.language),
						})}
				{open > 0 && <> {t("conflictPredictor:waves.conflictTimes.open", { count: open })}</>}
			</span>
		</Notice>
	);
}
