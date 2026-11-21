import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ACHIEVEMENT_IDS,
	type AchievementId,
} from "../lib/pixel-office-achievements";

/** When each achievement was first seen earned, per project id (ISO dates). */
export type UnlockedByProject = Record<
	string,
	Partial<Record<AchievementId, string>>
>;

interface AchievementsState {
	unlocked: UnlockedByProject;
	/**
	 * Note what a project has earned and return what is new since last time.
	 *
	 * The first record of a project is silent: a project that already shipped
	 * thirty tasks before the feature existed gets its achievements without six
	 * toasts in a row on the first visit, as the office's chimes stay silent
	 * for agents already waiting when the view opens.
	 */
	record: (projectId: string, earned: readonly AchievementId[], at: Date) => AchievementId[];
}

const KNOWN: ReadonlySet<string> = new Set(ACHIEVEMENT_IDS);

/** Keep only well-formed entries of a persisted map: it is local storage, not a type. */
function sanitize(value: unknown): UnlockedByProject {
	if (!value || typeof value !== "object") return {};
	const result: UnlockedByProject = {};
	for (const [projectId, entries] of Object.entries(value)) {
		if (!entries || typeof entries !== "object") continue;
		const kept: Partial<Record<AchievementId, string>> = {};
		for (const [id, at] of Object.entries(entries)) {
			if (KNOWN.has(id) && typeof at === "string") kept[id as AchievementId] = at;
		}
		result[projectId] = kept;
	}
	return result;
}

export const usePixelOfficeAchievementsStore = create<AchievementsState>()(
	persist(
		(set, get) => ({
			unlocked: {},
			record: (projectId, earned, at) => {
				const known = get().unlocked[projectId];
				const fresh = earned.filter((id) => !known?.[id]);
				if (known && fresh.length === 0) return [];
				const stamp = at.toISOString();
				const next = { ...(known ?? {}) };
				for (const id of fresh) next[id] = stamp;
				set((state) => ({ unlocked: { ...state.unlocked, [projectId]: next } }));
				return known ? fresh : [];
			},
		}),
		{
			name: "pixel-office-achievements",
			partialize: (state) => ({ unlocked: state.unlocked }),
			merge: (persisted, current) => ({
				...current,
				unlocked: sanitize((persisted as { unlocked?: unknown } | null)?.unlocked),
			}),
		},
	),
);
