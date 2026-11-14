import { create } from "zustand";
import type {
	CompanionConfig,
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../../shared/types/live-companion";
import { useProjectStore } from "./project-store";

interface LiveCompanionStoreState {
	// State
	companionState: CompanionState;
	config: CompanionConfig | null;
	suggestions: LiveSuggestion[];
	takeovers: TakeoverProposal[];
	recentChanges: FileChangeEvent[];
	error: string | null;
	isLoading: boolean;

	// Actions
	setCompanionState: (state: CompanionState) => void;
	setConfig: (config: CompanionConfig) => void;
	setSuggestions: (suggestions: LiveSuggestion[]) => void;
	addSuggestion: (suggestion: LiveSuggestion) => void;
	removeSuggestion: (suggestionId: string) => void;
	setTakeovers: (takeovers: TakeoverProposal[]) => void;
	addTakeover: (proposal: TakeoverProposal) => void;
	removeTakeover: (proposalId: string) => void;
	addFileChange: (event: FileChangeEvent) => void;
	setError: (error: string | null) => void;
	setIsLoading: (isLoading: boolean) => void;
	reset: () => void;
}

const initialCompanionState: CompanionState = {
	active: false,
	watching_project: "",
	files_watched: 0,
	changes_detected: 0,
	suggestions_generated: 0,
	suggestions_accepted: 0,
	takeovers_proposed: 0,
	takeovers_accepted: 0,
	started_at: "",
	last_change_at: "",
};

const initialState = {
	companionState: initialCompanionState,
	config: null as CompanionConfig | null,
	suggestions: [] as LiveSuggestion[],
	takeovers: [] as TakeoverProposal[],
	recentChanges: [] as FileChangeEvent[],
	error: null as string | null,
	isLoading: false,
};

export const useLiveCompanionStore = create<LiveCompanionStoreState>((set) => ({
	...initialState,

	setCompanionState: (companionState) => set({ companionState }),

	setConfig: (config) => set({ config }),

	setSuggestions: (suggestions) => set({ suggestions }),

	addSuggestion: (suggestion) =>
		set((state) => ({
			suggestions: [
				suggestion,
				...state.suggestions.filter(
					(s) => s.suggestion_id !== suggestion.suggestion_id,
				),
			].slice(0, 50),
		})),

	removeSuggestion: (suggestionId) =>
		set((state) => ({
			suggestions: state.suggestions.filter(
				(s) => s.suggestion_id !== suggestionId,
			),
		})),

	setTakeovers: (takeovers) => set({ takeovers }),

	addTakeover: (proposal) =>
		set((state) => ({
			takeovers: [
				proposal,
				...state.takeovers.filter((t) => t.proposal_id !== proposal.proposal_id),
			],
		})),

	removeTakeover: (proposalId) =>
		set((state) => ({
			takeovers: state.takeovers.filter((t) => t.proposal_id !== proposalId),
		})),

	addFileChange: (event) =>
		set((state) => ({
			recentChanges: [event, ...state.recentChanges].slice(0, 30),
		})),

	setError: (error) => set({ error }),

	setIsLoading: (isLoading) => set({ isLoading }),

	reset: () => set(initialState),
}));

/**
 * True when `projectDir` is the project the page shows: a suggestion pushed
 * for the watched project must not land in another project's list.
 */
function isShownProject(projectDir: string | undefined): boolean {
	if (!projectDir) return true;
	const shown = useProjectStore.getState().getActiveProject()?.path;
	if (!shown) return true;
	const normalize = (p: string) => p.replace(/[\\/]+$/, "").replaceAll("\\", "/");
	return normalize(shown) === normalize(projectDir);
}

/** Keeps the store in step with what the companion pushes from main. */
export function setupLiveCompanionListeners(): () => void {
	const api = window.electronAPI;
	const store = () => useLiveCompanionStore.getState();
	const cleanups = [
		api.onLiveCompanionStateChanged((state) => store().setCompanionState(state)),
		api.onLiveCompanionSuggestion((suggestion) => {
			if (isShownProject(suggestion.project_dir)) store().addSuggestion(suggestion);
		}),
		api.onLiveCompanionTakeoverProposal((proposal) => {
			if (isShownProject(proposal.project_dir)) store().addTakeover(proposal);
		}),
		api.onLiveCompanionFileChange((event) => store().addFileChange(event)),
	];
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}

// ── Async helper functions ──────────────────────────────────────

export async function startCompanion(projectDir: string): Promise<boolean> {
	const store = useLiveCompanionStore.getState();
	store.setIsLoading(true);
	store.setError(null);
	try {
		const result = await window.electronAPI.liveCompanionStart(projectDir);
		if (!result.success) store.setError(result.error ?? null);
		return result.success;
	} catch (error) {
		store.setError(error instanceof Error ? error.message : String(error));
		return false;
	} finally {
		store.setIsLoading(false);
	}
}

export async function stopCompanion(): Promise<boolean> {
	try {
		const result = await window.electronAPI.liveCompanionStop();
		return result.success;
	} catch (error) {
		console.error("[LiveCompanion] Failed to stop:", error);
		return false;
	}
}

export async function loadCompanionState(): Promise<void> {
	try {
		const result = await window.electronAPI.liveCompanionGetState();
		if (result.success && result.data) {
			useLiveCompanionStore.getState().setCompanionState(result.data);
		}
	} catch (error) {
		console.error("[LiveCompanion] Failed to load state:", error);
	}
}

export async function loadCompanionConfig(): Promise<void> {
	try {
		const result = await window.electronAPI.liveCompanionGetConfig();
		if (result.success && result.data) {
			useLiveCompanionStore.getState().setConfig(result.data);
		}
	} catch (error) {
		console.error("[LiveCompanion] Failed to load config:", error);
	}
}

export async function updateCompanionConfig(
	updates: Partial<CompanionConfig>,
): Promise<boolean> {
	try {
		const result = await window.electronAPI.liveCompanionUpdateConfig(updates);
		if (result.success && result.data) {
			useLiveCompanionStore.getState().setConfig(result.data);
			return true;
		}
		return false;
	} catch (error) {
		console.error("[LiveCompanion] Failed to update config:", error);
		return false;
	}
}

/** The active suggestions of `projectDir`. */
export async function loadSuggestions(projectDir?: string): Promise<void> {
	try {
		const result = await window.electronAPI.liveCompanionGetSuggestions(projectDir);
		if (result.success && result.data) {
			useLiveCompanionStore.getState().setSuggestions([...result.data].reverse());
		}
	} catch (error) {
		console.error("[LiveCompanion] Failed to load suggestions:", error);
	}
}

export async function dismissSuggestion(
	suggestionId: string,
): Promise<boolean> {
	try {
		const result =
			await window.electronAPI.liveCompanionDismissSuggestion(suggestionId);
		if (result.success) {
			useLiveCompanionStore.getState().removeSuggestion(suggestionId);
			return true;
		}
		return false;
	} catch (error) {
		console.error("[LiveCompanion] Failed to dismiss suggestion:", error);
		return false;
	}
}

/** Mark a suggestion handled once the page turned it into a Kanban task. */
export async function applySuggestion(suggestionId: string): Promise<boolean> {
	try {
		const result =
			await window.electronAPI.liveCompanionApplySuggestion(suggestionId);
		if (result.success) {
			useLiveCompanionStore.getState().removeSuggestion(suggestionId);
			return true;
		}
		return false;
	} catch (error) {
		console.error("[LiveCompanion] Failed to apply suggestion:", error);
		return false;
	}
}

/** The pending takeover proposals of `projectDir`. */
export async function loadTakeovers(projectDir?: string): Promise<void> {
	try {
		const result = await window.electronAPI.liveCompanionGetTakeovers(projectDir);
		if (result.success && result.data) {
			useLiveCompanionStore.getState().setTakeovers([...result.data].reverse());
		}
	} catch (error) {
		console.error("[LiveCompanion] Failed to load takeovers:", error);
	}
}

/** Mark a proposal accepted once the page turned it into a Kanban task. */
export async function acceptTakeover(proposalId: string): Promise<boolean> {
	try {
		const result = await window.electronAPI.liveCompanionAcceptTakeover(proposalId);
		if (result.success) {
			useLiveCompanionStore.getState().removeTakeover(proposalId);
			return true;
		}
		return false;
	} catch (error) {
		console.error("[LiveCompanion] Failed to accept takeover:", error);
		return false;
	}
}

export async function declineTakeover(proposalId: string): Promise<boolean> {
	try {
		const result =
			await window.electronAPI.liveCompanionDeclineTakeover(proposalId);
		if (result.success) {
			useLiveCompanionStore.getState().removeTakeover(proposalId);
			return true;
		}
		return false;
	} catch (error) {
		console.error("[LiveCompanion] Failed to decline takeover:", error);
		return false;
	}
}
