/**
 * Agent Replay & Debug Mode Store — Zustand state management.
 *
 * Manages:
 * - Replay session list and selection
 * - Timeline playback (play, pause, step, speed)
 * - Step detail viewing with file diffs
 * - Breakpoint management
 * - A/B session comparison
 * - File heatmap data
 * - Token timeline data
 */

import i18n from "i18next";
import { create } from "zustand";
import type { ReplayResult } from "../../preload/api/modules/replay-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileDiff {
	file_path: string;
	operation: string;
	before_content: string | null;
	after_content: string | null;
	diff_lines: string[] | null;
	line_count_before: number;
	line_count_after: number;
}

export interface ReplayStep {
	id: string;
	step_index: number;
	step_type: string;
	timestamp: number;
	duration_ms: number;
	label: string;
	description: string;
	reasoning: string;
	tool_name: string | null;
	tool_input: Record<string, unknown> | null;
	tool_output: string | null;
	file_diffs: FileDiff[];
	input_tokens: number;
	output_tokens: number;
	cumulative_tokens: number;
	cost_usd: number;
	cumulative_cost_usd: number;
	decision_node_id: string | null;
	parent_step_id: string | null;
	children_step_ids: string[];
	options_considered: string[];
	chosen_option: string | null;
	is_breakpoint: boolean;
	breakpoint_id: string | null;
}

export interface Breakpoint {
	id: string;
	breakpoint_type: string;
	enabled: boolean;
	condition: string;
	description: string;
	hit_count: number;
}

export interface ReplaySessionSummary {
	session_id: string;
	agent_name: string;
	agent_role: string;
	provider: string;
	model_label: string;
	task_description: string;
	start_time: number;
	end_time: number | null;
	duration_seconds: number;
	step_count: number;
	total_tokens: number;
	total_cost_usd: number;
	total_tool_calls: number;
	total_file_changes: number;
	status: string;
	tags: string[];
}

export interface ReplaySessionFull extends ReplaySessionSummary {
	agent_id: string | null;
	model: string;
	project_path: string;
	steps: ReplayStep[];
	breakpoints: Breakpoint[];
	files_touched: string[];
	file_heatmap: Record<string, number>;
	tool_usage_stats: Record<string, number>;
	token_timeline: TokenTimelineEntry[];
}

export interface TokenTimelineEntry {
	step_index: number;
	timestamp: number;
	input_tokens: number;
	output_tokens: number;
	cumulative: number;
	cost_usd: number;
	cumulative_cost_usd: number;
}

export interface HeatmapEntry {
	file_path: string;
	touch_count: number;
	intensity: number;
}

export interface ABComparison {
	id: string;
	session_a_id: string;
	session_b_id: string;
	created_at: number;
	token_diff: number;
	cost_diff: number;
	duration_diff: number;
	step_count_diff: number;
	tool_calls_diff: number;
	file_changes_diff: number;
	common_files: string[];
	unique_files_a: string[];
	unique_files_b: string[];
	common_tools: string[];
	unique_tools_a: string[];
	unique_tools_b: string[];
}

type ReplayTab =
	| "timeline"
	| "diff"
	| "heatmap"
	| "tokens"
	| "debug"
	| "compare"
	| "timeTravel";

export interface AgentReplayState {
	// Session list
	sessions: ReplaySessionSummary[];
	sessionsLoading: boolean;

	// Active replay session
	activeSession: ReplaySessionFull | null;
	activeSessionLoading: boolean;

	// Playback state
	currentStepIndex: number;
	isPlaying: boolean;
	playbackSpeed: number; // 1x, 2x, 4x, 0.5x
	playbackTimer: ReturnType<typeof setTimeout> | null;

	// UI state
	activeTab: ReplayTab;
	selectedStepId: string | null;

	// Heatmap
	heatmap: HeatmapEntry[];

	// A/B Comparison
	comparison: ABComparison | null;
	comparisonSessionA: ReplaySessionSummary | null;
	comparisonSessionB: ReplaySessionSummary | null;
	compareLoading: boolean;

	// Debug mode
	breakpoints: Breakpoint[];

	// Error
	error: string | null;

	// Actions
	fetchSessions: () => Promise<void>;
	loadSession: (sessionId: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<void>;
	closeSession: () => void;

	// Playback
	play: () => void;
	pause: () => void;
	stop: () => void;
	stepForward: () => void;
	stepBackward: () => void;
	goToStep: (index: number) => void;
	setPlaybackSpeed: (speed: number) => void;

	// Tab
	setActiveTab: (tab: ReplayTab) => void;
	selectStep: (stepId: string | null) => void;

	// Heatmap
	fetchHeatmap: (sessionId: string) => Promise<void>;

	// A/B Comparison
	compareSessionsAction: (
		sessionAId: string,
		sessionBId: string,
	) => Promise<void>;
	clearComparison: () => void;

	// Breakpoints
	addBreakpoint: (
		sessionId: string,
		type: string,
		condition: string,
		description?: string,
	) => Promise<void>;
	removeBreakpoint: (sessionId: string, breakpointId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * A backend answer, read by main (`replay-handlers.ts`): its body, or an error
 * that says the backend did not answer when nothing did.
 */
async function replayCall<T>(call: Promise<ReplayResult<T>>): Promise<T> {
	const res = await call;
	if (res.success) return res;
	if (res.unreachable) throw new Error(i18n.t("replay:errors.backendUnreachable"));
	throw new Error(res.error);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAgentReplayStore = create<AgentReplayState>((set, get) => ({
	// Initial state
	sessions: [],
	sessionsLoading: false,
	activeSession: null,
	activeSessionLoading: false,
	currentStepIndex: 0,
	isPlaying: false,
	playbackSpeed: 1,
	playbackTimer: null,
	activeTab: "timeline",
	selectedStepId: null,
	heatmap: [],
	comparison: null,
	comparisonSessionA: null,
	comparisonSessionB: null,
	compareLoading: false,
	breakpoints: [],
	error: null,

	// --- Session list ---
	fetchSessions: async () => {
		set({ sessionsLoading: true, error: null });
		try {
			const res = await replayCall(
				window.electronAPI.listReplaySessions<{
					sessions: ReplaySessionSummary[];
				}>(),
			);
			set({ sessions: res.sessions, sessionsLoading: false });
		} catch (e) {
			set({ error: (e as Error).message, sessionsLoading: false });
		}
	},

	loadSession: async (sessionId: string) => {
		set({
			activeSessionLoading: true,
			error: null,
			currentStepIndex: 0,
			isPlaying: false,
		});
		try {
			const res = await replayCall(
				window.electronAPI.getReplaySession<{ session: ReplaySessionFull }>(
					sessionId,
				),
			);
			set({
				activeSession: res.session,
				activeSessionLoading: false,
				breakpoints: res.session.breakpoints || [],
				activeTab: "timeline",
			});
		} catch (e) {
			set({ error: (e as Error).message, activeSessionLoading: false });
		}
	},

	deleteSession: async (sessionId: string) => {
		try {
			await replayCall(window.electronAPI.deleteReplaySession(sessionId));
			set((s) => ({
				sessions: s.sessions.filter((sess) => sess.session_id !== sessionId),
				activeSession:
					s.activeSession?.session_id === sessionId ? null : s.activeSession,
			}));
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},

	closeSession: () => {
		const { playbackTimer } = get();
		if (playbackTimer) clearTimeout(playbackTimer);
		set({
			activeSession: null,
			currentStepIndex: 0,
			isPlaying: false,
			playbackTimer: null,
			selectedStepId: null,
			heatmap: [],
			comparison: null,
			comparisonSessionA: null,
			comparisonSessionB: null,
		});
	},

	// --- Playback ---
	play: () => {
		const { activeSession, currentStepIndex, playbackSpeed } = get();
		if (!activeSession || currentStepIndex >= activeSession.steps.length - 1)
			return;

		set({ isPlaying: true });

		const advanceStep = () => {
			const {
				currentStepIndex: idx,
				activeSession: sess,
				isPlaying: playing,
			} = get();
			if (!playing || !sess || idx >= sess.steps.length - 1) {
				set({ isPlaying: false, playbackTimer: null });
				return;
			}

			const nextIdx = idx + 1;
			const currentStep = sess.steps[idx];
			const nextStep = sess.steps[nextIdx];

			// Check for breakpoints
			if (nextStep.is_breakpoint) {
				set({
					currentStepIndex: nextIdx,
					selectedStepId: nextStep.id,
					isPlaying: false,
					playbackTimer: null,
				});
				return;
			}

			set({ currentStepIndex: nextIdx, selectedStepId: nextStep.id });

			// Schedule next step based on real timing difference
			const timeDiff = (nextStep.timestamp - currentStep.timestamp) * 1000;
			const delay = Math.max(100, Math.min(timeDiff / playbackSpeed, 3000)); // Clamp between 100ms and 3s

			const timer = setTimeout(advanceStep, delay);
			set({ playbackTimer: timer });
		};

		advanceStep();
	},

	pause: () => {
		const { playbackTimer } = get();
		if (playbackTimer) clearTimeout(playbackTimer);
		set({ isPlaying: false, playbackTimer: null });
	},

	stop: () => {
		const { playbackTimer } = get();
		if (playbackTimer) clearTimeout(playbackTimer);
		set({
			isPlaying: false,
			playbackTimer: null,
			currentStepIndex: 0,
			selectedStepId: null,
		});
	},

	stepForward: () => {
		const { activeSession, currentStepIndex } = get();
		if (!activeSession || currentStepIndex >= activeSession.steps.length - 1)
			return;
		const nextIdx = currentStepIndex + 1;
		set({
			currentStepIndex: nextIdx,
			selectedStepId: activeSession.steps[nextIdx].id,
		});
	},

	stepBackward: () => {
		const { activeSession, currentStepIndex } = get();
		if (!activeSession || currentStepIndex <= 0) return;
		const prevIdx = currentStepIndex - 1;
		set({
			currentStepIndex: prevIdx,
			selectedStepId: activeSession.steps[prevIdx].id,
		});
	},

	goToStep: (index: number) => {
		const { activeSession } = get();
		if (!activeSession || index < 0 || index >= activeSession.steps.length)
			return;
		set({
			currentStepIndex: index,
			selectedStepId: activeSession.steps[index].id,
		});
	},

	setPlaybackSpeed: (speed: number) => {
		set({ playbackSpeed: speed });
	},

	// --- Tab ---
	setActiveTab: (tab: ReplayTab) => {
		set({ activeTab: tab });
	},

	selectStep: (stepId: string | null) => {
		const { activeSession } = get();
		if (!activeSession || !stepId) {
			set({ selectedStepId: null });
			return;
		}
		const idx = activeSession.steps.findIndex((s) => s.id === stepId);
		set({
			selectedStepId: stepId,
			currentStepIndex: idx >= 0 ? idx : get().currentStepIndex,
		});
	},

	// --- Heatmap ---
	fetchHeatmap: async (sessionId: string) => {
		try {
			const res = await replayCall(
				window.electronAPI.getReplayHeatmap<{ heatmap: HeatmapEntry[] }>(
					sessionId,
				),
			);
			set({ heatmap: res.heatmap });
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},

	// --- A/B Comparison ---
	compareSessionsAction: async (sessionAId: string, sessionBId: string) => {
		set({ compareLoading: true, error: null });
		try {
			const res = await replayCall(
				window.electronAPI.compareReplaySessions<{
					comparison: ABComparison;
					session_a: ReplaySessionSummary;
					session_b: ReplaySessionSummary;
				}>(sessionAId, sessionBId),
			);
			set({
				comparison: res.comparison,
				comparisonSessionA: res.session_a,
				comparisonSessionB: res.session_b,
				compareLoading: false,
				activeTab: "compare",
			});
		} catch (e) {
			set({ error: (e as Error).message, compareLoading: false });
		}
	},

	clearComparison: () => {
		set({
			comparison: null,
			comparisonSessionA: null,
			comparisonSessionB: null,
		});
	},

	// --- Breakpoints ---
	addBreakpoint: async (
		sessionId: string,
		type: string,
		condition: string,
		description?: string,
	) => {
		try {
			const res = await replayCall(
				window.electronAPI.addReplayBreakpoint<{ breakpoint: Breakpoint }>(
					sessionId,
					{ breakpoint_type: type, condition, description: description || "" },
				),
			);
			set((s) => ({ breakpoints: [...s.breakpoints, res.breakpoint] }));
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},

	removeBreakpoint: async (sessionId: string, breakpointId: string) => {
		try {
			await replayCall(
				window.electronAPI.removeReplayBreakpoint(sessionId, breakpointId),
			);
			set((s) => ({
				breakpoints: s.breakpoints.filter((b) => b.id !== breakpointId),
			}));
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},
}));
