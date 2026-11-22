/**
 * How replays are shared (#347): this machine's figures, and those of a
 * server project's team links, as main read them (`main/replay-usage.ts`).
 * Both are counted where the replays live and sent nowhere else.
 *
 * Also the person's own team links on every project of the server, which
 * Settings lists so that each can be revoked.
 */

import { create } from "zustand";
import type {
	ReplayMyTeamShare,
	ReplayTeamUsage,
	ReplayUsage,
} from "../../shared/types/replay-share";
import { failure, type ReplayShareNotice } from "./replay-share-store";

interface ReplayUsageState {
	local: ReplayUsage | null;
	/** Each server project's aggregates, as last read. */
	team: Record<string, ReplayTeamUsage>;
	loading: boolean;
	error: ReplayShareNotice | null;
	/** The person's own links, on every project; null until listed. */
	mine: ReplayMyTeamShare[] | null;
	mineLoading: boolean;
	mineError: ReplayShareNotice | null;
	/** Reads this machine's figures, and `projectId`'s when it is a server project. */
	load: (projectId?: string | null) => Promise<void>;
	loadMine: () => Promise<void>;
	revokeMine: (share: ReplayMyTeamShare) => Promise<void>;
}

export const useReplayUsageStore = create<ReplayUsageState>((set, get) => ({
	local: null,
	team: {},
	loading: false,
	error: null,
	mine: null,
	mineLoading: false,
	mineError: null,

	load: async (projectId) => {
		set({ loading: true, error: null });
		const [local, team] = await Promise.all([
			window.electronAPI.getReplayUsage(),
			projectId ? window.electronAPI.getReplayTeamUsage(projectId) : null,
		]);
		set((state) => {
			const next: Partial<ReplayUsageState> = { loading: false };
			if (local.success) next.local = local.usage;
			else next.error = failure(local);
			if (team && projectId) {
				if (team.success) next.team = { ...state.team, [projectId]: team.usage };
				else next.error ??= failure(team);
			}
			return next;
		});
	},

	loadMine: async () => {
		set({ mineLoading: true, mineError: null });
		const result = await window.electronAPI.listMyReplayTeamShares();
		if (!result.success) {
			set({ mineLoading: false, mineError: failure(result) });
			return;
		}
		set({ mineLoading: false, mine: result.shares });
	},

	revokeMine: async (share) => {
		const result = await window.electronAPI.revokeReplayTeamShare(share.projectId, share.id);
		if (!result.success) {
			set({ mineError: failure(result) });
			return;
		}
		await get().loadMine();
	},
}));
