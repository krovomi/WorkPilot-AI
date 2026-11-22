import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../../shared/types/task";
import {
	type AchievementId,
	collectFacts,
	earnedAchievements,
	type IncidentFact,
	incidentFactsOf,
} from "../../lib/pixel-office-achievements";
import { usePixelOfficeAchievementsStore } from "../../stores/pixel-office-achievements-store";

interface Options {
	readonly projectId: string;
	readonly projectPath: string;
	readonly tasks: readonly Task[];
	/** False while the task list is loading: nothing is recorded from a half list. */
	readonly ready: boolean;
	/**
	 * A server project: its folder here is the app's mirror, so no local
	 * runner reads it and it counts no incident.
	 */
	readonly remote?: boolean;
}

/**
 * The project's achievements, and the ones just earned, for the toast.
 *
 * Incidents are read from the Self-Healing runner before the first
 * evaluation, so a project seen for the first time is recorded with all it
 * has already earned, quietly, instead of toasting its incident achievements
 * a moment later. A runner that fails counts as no incident. `refresh` reads
 * them again and moves "now" for the weekly rule (TV mode calls it).
 */
export function useOfficeAchievements({
	projectId,
	projectPath,
	tasks,
	ready,
	remote = false,
}: Options) {
	const [incidents, setIncidents] = useState<IncidentFact[] | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [toasts, setToasts] = useState<AchievementId[]>([]);
	const record = usePixelOfficeAchievementsStore((s) => s.record);
	const unlocked = usePixelOfficeAchievementsStore((s) => s.unlocked[projectId]);

	// The project the answer must still be for when it arrives.
	const pathRef = useRef(projectPath);
	pathRef.current = projectPath;

	const load = useCallback(() => {
		const done = (facts: IncidentFact[]) => {
			if (pathRef.current === projectPath) setIncidents(facts);
		};
		const read = globalThis.electronAPI?.selfHealing?.getIncidents;
		if (!read || remote) {
			done([]);
			return;
		}
		read(projectPath).then(
			(result) => done(result?.success ? incidentFactsOf(result.data) : []),
			() => done([]),
		);
	}, [projectPath, remote]);

	useEffect(() => {
		setIncidents(null);
		load();
	}, [load]);

	const refresh = useCallback(() => {
		setNow(Date.now());
		load();
	}, [load]);

	const projectTasks = useMemo(
		() => tasks.filter((t) => t.projectId === projectId),
		[tasks, projectId],
	);

	useEffect(() => {
		if (!incidents || !ready) return;
		const earned = earnedAchievements(collectFacts(projectTasks, incidents), now);
		const fresh = record(projectId, earned, new Date(now));
		if (fresh.length > 0) setToasts((queue) => [...queue, ...fresh]);
	}, [projectId, projectTasks, incidents, ready, record, now]);

	const dismissToast = useCallback(() => setToasts((queue) => queue.slice(1)), []);

	return {
		unlocked: unlocked ?? {},
		toast: toasts[0],
		dismissToast,
		refresh,
		/** The incidents last read (null while reading), for the season goals. */
		incidents,
		/** The instant the rules were last evaluated at. */
		now,
		projectTasks,
	};
}
