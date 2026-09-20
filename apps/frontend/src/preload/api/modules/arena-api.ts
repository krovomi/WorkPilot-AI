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
		arenaStartBattle: (request) => invokeIpc("arena:startBattle", request),
		arenaVote: (vote) => invokeIpc("arena:vote", vote),
		arenaGetBattles: () => invokeIpc("arena:getBattles"),
		arenaGetAnalytics: () => invokeIpc("arena:getAnalytics"),
		arenaClearHistory: () => invokeIpc("arena:clearHistory"),

		onArenaBattleProgress: (callback) =>
			createIpcListener("arena:battleProgress", callback),
		onArenaBattleResult: (callback) =>
			createIpcListener("arena:battleResult", callback),
		onArenaBattleComplete: (callback) =>
			createIpcListener("arena:battleComplete", callback),
		onArenaBattleError: (callback) =>
			createIpcListener("arena:battleError", callback),
	};
}
