import type {
	ArenaAnalytics,
	ArenaBattle,
	ArenaBattleCompleteEvent,
	ArenaBattleProgressEvent,
	ArenaBattleResultEvent,
	ArenaLabel,
	ArenaParticipant,
} from "@shared/types/arena";
import { create } from "zustand";

// ─── Store State ────────────────────────────────────────────────────────────

interface ArenaState {
	isOpen: boolean;

	/** Current battle being run or voted on */
	activeBattle: ArenaBattle | null;

	/** All historical battles */
	battles: ArenaBattle[];

	/** Analytics aggregated from all votes */
	analytics: ArenaAnalytics | null;

	/** Loading states */
	isStartingBattle: boolean;
	isLoadingHistory: boolean;
	isLoadingAnalytics: boolean;

	/** Auto-routing enabled */
	autoRoutingEnabled: boolean;

	error: string | null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

interface ArenaActions {
	openDialog: () => void;
	closeDialog: () => void;

	setActiveBattle: (battle: ArenaBattle | null) => void;
	setIsStartingBattle: (v: boolean) => void;
	setAutoRoutingEnabled: (v: boolean) => void;
	setError: (error: string | null) => void;

	/** Handle streaming chunk from a participant */
	handleBattleProgress: (event: ArenaBattleProgressEvent) => void;

	/** Handle individual participant completion */
	handleBattleResult: (event: ArenaBattleResultEvent) => void;

	/** Handle full battle completion */
	handleBattleComplete: (event: ArenaBattleCompleteEvent) => void;

	/** Handle a battle that stopped on an error */
	handleBattleError: (event: { battleId: string; error: string }) => void;

	/** Submit a vote for a battle */
	submitVote: (battleId: string, winnerLabel: ArenaLabel) => void;

	/** Load battle history from main process */
	loadHistory: () => Promise<void>;

	/** Load analytics from main process */
	loadAnalytics: () => Promise<void>;
}

// ─── Initial State ────────────────────────────────────────────────────────────

const initialState: ArenaState = {
	isOpen: false,
	activeBattle: null,
	battles: [],
	analytics: null,
	isStartingBattle: false,
	isLoadingHistory: false,
	isLoadingAnalytics: false,
	autoRoutingEnabled: false,
	error: null,
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const useArenaStore = create<ArenaState & ArenaActions>((set, get) => ({
	...initialState,

	openDialog: () => set({ isOpen: true, error: null }),
	closeDialog: () => set({ isOpen: false }),

	setActiveBattle: (battle) => set({ activeBattle: battle }),
	setIsStartingBattle: (v) => set({ isStartingBattle: v }),
	setAutoRoutingEnabled: (v) => set({ autoRoutingEnabled: v }),
	setError: (error) => set({ error }),

	handleBattleProgress: (event) => {
		const { activeBattle } = get();
		if (!activeBattle || activeBattle.id !== event.battleId) return;

		const participants = activeBattle.participants.map(
			(p): ArenaParticipant => {
				if (p.label !== event.label) return p;
				// Only the text grows while the answer streams. Tokens and cost
				// are what the provider reports at the end, and a running
				// counter guessed from the text so far reads exactly like one.
				return {
					...p,
					output: p.output + event.chunk,
					status: "running",
				};
			},
		);

		set({ activeBattle: { ...activeBattle, participants } });
	},

	handleBattleResult: (event) => {
		const { activeBattle } = get();
		if (!activeBattle || activeBattle.id !== event.battleId) return;

		const participants = activeBattle.participants.map(
			(p): ArenaParticipant => {
				if (p.label !== event.label) return p;
				return {
					...p,
					output: event.output,
					status: event.error ? "error" : "completed",
					tokensUsed: event.tokensUsed,
					costUsd: event.costUsd,
					usageEstimated: event.usageEstimated,
					durationMs: event.durationMs,
					error: event.error,
				};
			},
		);

		set({ activeBattle: { ...activeBattle, participants } });
	},

	handleBattleComplete: (event) => {
		const { activeBattle } = get();
		if (!activeBattle || activeBattle.id !== event.battleId) return;

		const updatedBattle: ArenaBattle = {
			...activeBattle,
			participants: event.participants,
			status: "voting",
			completedAt: Date.now(),
		};

		set({ activeBattle: updatedBattle });
	},

	handleBattleError: ({ battleId, error }) => {
		const { activeBattle } = get();
		if (!activeBattle || activeBattle.id !== battleId) return;
		// The battle is over: left on "running", it would spin for ever.
		set({ activeBattle: { ...activeBattle, status: "error" }, error });
	},

	submitVote: async (battleId, winnerLabel) => {
		const { activeBattle } = get();
		if (!activeBattle || activeBattle.id !== battleId) return;

		const winner = activeBattle.participants.find(
			(p) => p.label === winnerLabel,
		);
		if (!winner) return;

		try {
			if (typeof globalThis.electronAPI?.arenaVote !== "function") {
				set({
					error: "Arena API not available — please restart the application.",
				});
				return;
			}
			const result = await globalThis.electronAPI.arenaVote({
				battleId,
				winnerLabel,
				winnerContenderId: winner.contenderId,
				taskType: activeBattle.taskType,
				votedAt: Date.now(),
			});

			if (result.success) {
				const updatedBattle: ArenaBattle = {
					...activeBattle,
					status: "completed",
					winnerLabel,
					votedAt: Date.now(),
					revealed: true,
				};

				const battles = [
					updatedBattle,
					...get().battles.filter((b) => b.id !== battleId),
				];
				set({ activeBattle: updatedBattle, battles });

				// Refresh analytics after vote
				get().loadAnalytics();
			}
		} catch (err) {
			set({
				error: err instanceof Error ? err.message : "Failed to submit vote",
			});
		}
	},

	loadHistory: async () => {
		set({ isLoadingHistory: true, error: null });
		try {
			if (typeof globalThis.electronAPI?.arenaGetBattles !== "function") {
				return;
			}
			const result = await globalThis.electronAPI.arenaGetBattles();
			if (result.success && result.data) {
				set({ battles: result.data });
			}
		} catch (err) {
			set({
				error: err instanceof Error ? err.message : "Failed to load history",
			});
		} finally {
			set({ isLoadingHistory: false });
		}
	},

	loadAnalytics: async () => {
		set({ isLoadingAnalytics: true });
		try {
			if (typeof globalThis.electronAPI?.arenaGetAnalytics !== "function") {
				return;
			}
			const result = await globalThis.electronAPI.arenaGetAnalytics();
			if (result.success && result.data) {
				set({ analytics: result.data });
			}
		} catch {
			// Silently fail analytics
		} finally {
			set({ isLoadingAnalytics: false });
		}
	},
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const openArenaDialog = () => {
	useArenaStore.getState().openDialog();
};

/**
 * Battle events, followed for the life of the window: a battle keeps running
 * in the main process when the dialog closes or another tab is shown.
 */
export function setupArenaListeners(): () => void {
	const api = globalThis.electronAPI;
	const store = () => useArenaStore.getState();
	const cleanups = [
		api.onArenaBattleProgress((event) => store().handleBattleProgress(event)),
		api.onArenaBattleResult((event) => store().handleBattleResult(event)),
		api.onArenaBattleComplete((event) => store().handleBattleComplete(event)),
		api.onArenaBattleError((event) => store().handleBattleError(event)),
	];
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}
