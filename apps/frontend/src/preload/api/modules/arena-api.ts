/**
 * Arena Mode preload API module
 */

import type {
	ArenaAnalytics,
	ArenaBattle,
	ArenaBattleCompleteEvent,
	ArenaBattleProgressEvent,
	ArenaBattleResultEvent,
	ArenaLabel,
	ArenaTaskType,
} from "../../../shared/types/arena";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

/**
 * A contestant, as the renderer names it: a (provider, model) pair taken from
 * the detected roster. The main process runs what it is handed — it does not
 * resolve a profile id, because a profile id only ever named a Claude account.
 */
export interface ArenaContenderRequest {
	id: string;
	provider: string;
	providerLabel?: string;
	model: string;
	modelLabel?: string;
}

export interface ArenaStartBattleRequest {
	taskType: ArenaTaskType;
	prompt: string;
	contenders: ArenaContenderRequest[];
	projectPath?: string;
}

export interface ArenaVoteRequest {
	battleId: string;
	winnerLabel: ArenaLabel;
	winnerContenderId: string;
	taskType: ArenaTaskType;
	votedAt: number;
}

export interface ArenaAPI {
	arenaStartBattle: (
		request: ArenaStartBattleRequest,
	) => Promise<{ success: boolean; data?: ArenaBattle; error?: string }>;
	arenaVote: (
		vote: ArenaVoteRequest,
	) => Promise<{ success: boolean; error?: string }>;
	arenaGetBattles: () => Promise<{
		success: boolean;
		data?: ArenaBattle[];
		error?: string;
	}>;
	arenaGetAnalytics: () => Promise<{
		success: boolean;
		data?: ArenaAnalytics;
		error?: string;
	}>;
	arenaClearHistory: () => Promise<{ success: boolean; error?: string }>;

	onArenaBattleProgress: (
		callback: (event: ArenaBattleProgressEvent) => void,
	) => () => void;
	onArenaBattleResult: (
		callback: (event: ArenaBattleResultEvent) => void,
	) => () => void;
	onArenaBattleComplete: (
		callback: (event: ArenaBattleCompleteEvent) => void,
	) => () => void;
	onArenaBattleError: (
		callback: (event: { battleId: string; error: string }) => void,
	) => () => void;
}

export function createArenaAPI(): ArenaAPI {
	return {
		arenaStartBattle: (request) => invokeIpc(IPC_CHANNELS.ARENA_START_BATTLE, request),
		arenaVote: (vote) => invokeIpc(IPC_CHANNELS.ARENA_VOTE, vote),
		arenaGetBattles: () => invokeIpc(IPC_CHANNELS.ARENA_GET_BATTLES),
		arenaGetAnalytics: () => invokeIpc(IPC_CHANNELS.ARENA_GET_ANALYTICS),
		arenaClearHistory: () => invokeIpc(IPC_CHANNELS.ARENA_CLEAR_HISTORY),

		onArenaBattleProgress: (callback) =>
			createIpcListener(IPC_CHANNELS.ARENA_BATTLE_PROGRESS, callback),
		onArenaBattleResult: (callback) =>
			createIpcListener(IPC_CHANNELS.ARENA_BATTLE_RESULT, callback),
		onArenaBattleComplete: (callback) =>
			createIpcListener(IPC_CHANNELS.ARENA_BATTLE_COMPLETE, callback),
		onArenaBattleError: (callback) =>
			createIpcListener(IPC_CHANNELS.ARENA_BATTLE_ERROR, callback),
	};
}
