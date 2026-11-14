/**
 * Mission Control Store — Zustand state for the multi-agent hub.
 *
 * Everything goes through the main process (`window.electronAPI.missionControl*`):
 * it proxies the state kept by the local backend and runs each agent's model
 * call with the agent's own provider. The page polls the state while a
 * session is open; an agent's answer, tokens and end of run arrive that way.
 */

import { create } from "zustand";
import type {
	MissionControlAgent,
	MissionControlDecisionNode,
	MissionControlDecisionTree,
	MissionControlEvent,
	MissionControlSession,
	MissionControlTokenUsage,
} from "../../shared/types/mission-control";
import { useProjectStore } from "./project-store";

export type AgentSlot = MissionControlAgent;
export type DecisionNode = MissionControlDecisionNode;
export type DecisionTree = MissionControlDecisionTree;
export type MCSession = MissionControlSession;
export type MCEvent = MissionControlEvent;
export type TokenUsage = MissionControlTokenUsage;

export interface MissionControlState {
	session: MCSession | null;
	isActive: boolean;
	agents: AgentSlot[];
	selectedAgentId: string | null;
	decisionTrees: Record<string, DecisionTree>;
	events: MCEvent[];
	isPolling: boolean;
	pollIntervalMs: number;
	lastPollAt: number | null;
	isLoading: boolean;
	error: string | null;

	startSession: () => Promise<void>;
	stopSession: () => Promise<void>;
	fetchState: () => Promise<void>;
	createAgent: (
		name: string,
		role: string,
		provider: string,
		model: string,
		modelLabel: string,
	) => Promise<AgentSlot | null>;
	removeAgent: (agentId: string) => Promise<void>;
	/** Start the agent on `task`; an empty task runs its last one again. */
	startAgent: (agentId: string, task: string) => Promise<void>;
	stopAgent: (agentId: string) => Promise<void>;
	selectAgent: (agentId: string | null) => void;
	startPolling: () => void;
	stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

const api = () => window.electronAPI;

export const useMissionControlStore = create<MissionControlState>((set, get) => ({
	session: null,
	isActive: false,
	agents: [],
	selectedAgentId: null,
	decisionTrees: {},
	events: [],
	isPolling: false,
	pollIntervalMs: 1500,
	lastPollAt: null,
	isLoading: false,
	error: null,

	startSession: async () => {
		set({ isLoading: true, error: null });
		try {
			const res = await api().missionControlStartSession();
			if (!res.success || !res.data) {
				set({ error: res.error ?? "Mission Control did not start", isLoading: false });
				return;
			}
			set({ session: res.data, isActive: true, isLoading: false });
			get().startPolling();
		} catch (e) {
			set({ error: (e as Error).message, isLoading: false });
		}
	},

	stopSession: async () => {
		get().stopPolling();
		try {
			await api().missionControlStopSession();
		} catch {
			// The page closes the session either way.
		}
		set({ session: null, isActive: false, agents: [], decisionTrees: {}, events: [] });
	},

	fetchState: async () => {
		try {
			const res = await api().missionControlGetState();
			if (!res.success || !res.data) {
				// Before a session, an unreachable backend is the launch's to report.
				if (get().isActive) set({ error: res.error ?? null });
				return;
			}
			const state = res.data;
			set({
				session: state.session,
				isActive: state.session.is_active,
				agents: state.agents,
				decisionTrees: state.decision_trees,
				events: state.recent_events,
				lastPollAt: Date.now(),
				error: null,
			});
		} catch (e) {
			if (get().isActive) set({ error: (e as Error).message });
		}
	},

	createAgent: async (name, role, provider, model, modelLabel) => {
		set({ isLoading: true });
		try {
			const res = await api().missionControlCreateAgent({
				name,
				role,
				provider,
				model,
				modelLabel,
			});
			if (res.success && res.data) {
				const agent = res.data;
				set((s) => ({ agents: [...s.agents, agent], isLoading: false }));
				return agent;
			}
			set({ error: res.error ?? null, isLoading: false });
			return null;
		} catch (e) {
			set({ error: (e as Error).message, isLoading: false });
			return null;
		}
	},

	removeAgent: async (agentId) => {
		const res = await api().missionControlRemoveAgent(agentId);
		if (!res.success) {
			set({ error: res.error ?? null });
			return;
		}
		set((s) => ({
			agents: s.agents.filter((a) => a.id !== agentId),
			selectedAgentId: s.selectedAgentId === agentId ? null : s.selectedAgentId,
		}));
	},

	startAgent: async (agentId, task) => {
		const projectId = useProjectStore.getState().selectedProjectId ?? undefined;
		const res = await api().missionControlStartAgent({ agentId, task, projectId });
		if (!res.success) {
			set({ error: res.error ?? null });
			return;
		}
		set({ error: null, selectedAgentId: agentId });
		await get().fetchState();
	},

	stopAgent: async (agentId) => {
		const res = await api().missionControlStopAgent(agentId);
		if (!res.success) set({ error: res.error ?? null });
		await get().fetchState();
	},

	selectAgent: (agentId) => set({ selectedAgentId: agentId }),

	startPolling: () => {
		if (pollTimer) return;
		set({ isPolling: true });
		pollTimer = setInterval(() => {
			void get().fetchState();
		}, get().pollIntervalMs);
		void get().fetchState();
	},

	stopPolling: () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		set({ isPolling: false });
	},
}));
