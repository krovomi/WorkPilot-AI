import { useMemo } from "react";
import type { Task } from "../../../shared/types/task";
import type { IncidentFact } from "../../lib/pixel-office-achievements";
import {
	collectSeasonFacts,
	DECOR_IDS,
	earnedDecor,
	seasonOf,
	seasonProgress,
} from "../../lib/pixel-office-seasons";

/**
 * The project's season at `now`: its goals and the decor earned so far.
 * Incidents still being read count as none.
 */
export function useOfficeSeason(
	tasks: readonly Task[],
	incidents: readonly IncidentFact[] | null,
	now: number,
) {
	return useMemo(() => {
		const at = new Date(now);
		const facts = collectSeasonFacts(tasks, incidents ?? []);
		const season = seasonOf(at);
		const decor = earnedDecor(facts, at);
		return {
			season,
			progress: seasonProgress(facts, season),
			decor,
			decorIds: DECOR_IDS.filter((id) => decor[id]),
		};
	}, [tasks, incidents, now]);
}
