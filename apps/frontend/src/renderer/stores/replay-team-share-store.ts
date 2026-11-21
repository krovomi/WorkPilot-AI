/**
 * Team links to a recorded agent session (#347): leave it with a server
 * project, list the project's links, revoke one, open one a teammate sent.
 *
 * Main does the work (`main/replay-team-share.ts`). The link made last is
 * kept here so the dialog can show it: the server never gives its token
 * again. Opening a link ends like an import, on the notice of the replay
 * view (`replay-share-store`).
 */

import { create } from "zustand";
import type {
	ReplayTeamShare,
	ReplayTeamShareRequest,
} from "../../shared/types/replay-share";
import { useAgentReplayStore } from "./agent-replay-store";
import { failure, type ReplayShareNotice, useReplayShareStore } from "./replay-share-store";

interface ReplayTeamShareState {
	/** The links of each server project, as last listed. */
	shares: Record<string, ReplayTeamShare[]>;
	loading: boolean;
	sharing: boolean;
	opening: boolean;
	/** The link just made, the only time its token is known. */
	lastLink: { projectId: string; link: string } | null;
	/** What went wrong in the share dialog. */
	error: ReplayShareNotice | null;
	loadShares: (projectId: string) => Promise<void>;
	share: (sessionId: string, request: ReplayTeamShareRequest) => Promise<boolean>;
	revoke: (projectId: string, shareId: string) => Promise<void>;
	/** Opens a pasted link; true once its session is imported. */
	openLink: (link: string) => Promise<boolean>;
	clear: () => void;
}

export const useReplayTeamShareStore = create<ReplayTeamShareState>((set, get) => ({
	shares: {},
	loading: false,
	sharing: false,
	opening: false,
	lastLink: null,
	error: null,

	loadShares: async (projectId) => {
		set({ loading: true });
		const result = await window.electronAPI.listReplayTeamShares(projectId);
		if (!result.success) {
			set({ loading: false, error: failure(result) });
			return;
		}
		set((state) => ({
			loading: false,
			shares: { ...state.shares, [projectId]: result.shares },
		}));
	},

	share: async (sessionId, request) => {
		set({ sharing: true, error: null, lastLink: null });
		const result = await window.electronAPI.shareReplayToTeam(sessionId, request);
		if (!result.success) {
			set({ sharing: false, error: failure(result) });
			return false;
		}
		const { projectId } = request;
		set((state) => ({
			sharing: false,
			lastLink: { projectId, link: result.link },
			shares: {
				...state.shares,
				[projectId]: [result.share, ...(state.shares[projectId] ?? [])],
			},
		}));
		return true;
	},

	revoke: async (projectId, shareId) => {
		const result = await window.electronAPI.revokeReplayTeamShare(projectId, shareId);
		if (!result.success) {
			set({ error: failure(result) });
			return;
		}
		await get().loadShares(projectId);
	},

	openLink: async (link) => {
		set({ opening: true });
		const result = await window.electronAPI.openReplayTeamShare(link.trim());
		set({ opening: false });
		if (!result.success) {
			useReplayShareStore.setState({ notice: failure(result) });
			return false;
		}
		if (result.canceled) return false;
		useReplayShareStore.setState({
			notice: {
				tone: "ok",
				key: "replay:share.imported",
				values: { name: result.session.agent_name },
			},
		});
		await useAgentReplayStore.getState().fetchSessions();
		return true;
	},

	clear: () => set({ error: null, lastLink: null }),
}));
