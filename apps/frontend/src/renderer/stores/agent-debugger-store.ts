import i18n from "i18next";
import { create } from "zustand";
import type {
	BreakpointSpec,
	DebugFrameDTO,
	DebugSessionSummary,
	ResumeAction,
} from "../../preload/api/modules/agent-debugger-api";

interface AgentDebuggerState {
	sessionId: string | null;
	sessions: DebugSessionSummary[];
	breakpoints: BreakpointSpec[];
	frames: DebugFrameDTO[];
	loading: boolean;
	error: string | null;

	listSessions: () => Promise<void>;
	attach: (sessionId: string) => Promise<void>;
	detach: () => Promise<void>;
	refresh: () => Promise<void>;
	addBreakpoint: (bp: BreakpointSpec) => Promise<void>;
	removeBreakpoint: (id: string) => Promise<void>;
	resume: (
		frameId: string,
		action: ResumeAction,
		options?: { toolInput?: Record<string, unknown>; reason?: string },
	) => Promise<void>;
}

export const useAgentDebuggerStore = create<AgentDebuggerState>((set, get) => ({
	sessionId: null,
	sessions: [],
	breakpoints: [],
	frames: [],
	loading: false,
	error: null,

	listSessions: async () => {
		try {
			const result = await window.electronAPI.listDebugSessions();
			// A runner that answers without a list must not crash the panel.
			set({ sessions: Array.isArray(result?.sessions) ? result.sessions : [] });
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},

	attach: async (sessionId) => {
		set({ loading: true, error: null });
		try {
			await window.electronAPI.attachDebugger(sessionId);
			set({ sessionId });
			await get().refresh();
		} catch (e) {
			set({ error: (e as Error).message });
		} finally {
			set({ loading: false });
		}
	},

	detach: async () => {
		const { sessionId } = get();
		if (!sessionId) return;
		try {
			await window.electronAPI.detachDebugger(sessionId);
		} catch (e) {
			// Still attached on the runner's side: say so, and keep showing it.
			set({ error: (e as Error).message });
			return;
		}
		set({ sessionId: null, breakpoints: [], frames: [], error: null });
		await get().listSessions();
	},

	refresh: async () => {
		const { sessionId } = get();
		if (!sessionId) return;
		// One runner process instead of two (breakpoints + frames in one shot),
		// which matters because refresh() is polled while attached. Guarded so a
		// transient runner failure during polling doesn't spam unhandled
		// rejections.
		try {
			const state = await window.electronAPI.getDebugState(sessionId);
			// Detached, or attached elsewhere, while the poll was out.
			if (get().sessionId !== sessionId) return;
			set({
				breakpoints: Array.isArray(state?.breakpoints) ? state.breakpoints : [],
				frames: Array.isArray(state?.frames) ? state.frames : [],
			});
		} catch (e) {
			if (get().sessionId === sessionId) set({ error: (e as Error).message });
		}
	},

	addBreakpoint: (bp) =>
		change(get, set, (sessionId) =>
			window.electronAPI.setBreakpoint(sessionId, bp),
		),

	removeBreakpoint: (id) =>
		change(get, set, (sessionId) =>
			window.electronAPI.removeBreakpoint(sessionId, id),
		),

	resume: (frameId, action, options) =>
		change(get, set, (sessionId) =>
			window.electronAPI.resumeFrame(sessionId, frameId, action, options),
		),
}));

/**
 * Send one change to the attached session, then read its state again. A
 * refusal is shown on the panel, where a person pressed the button, instead
 * of becoming an unhandled rejection nobody sees.
 */
async function change(
	get: () => AgentDebuggerState,
	set: (partial: Partial<AgentDebuggerState>) => void,
	call: (sessionId: string) => Promise<unknown>,
): Promise<void> {
	const { sessionId } = get();
	if (!sessionId) return;
	try {
		const result = await call(sessionId);
		// The runner answers a refusal (a frame that already resumed, say)
		// instead of failing: it is just as much the person's to see.
		if ((result as { ok?: boolean } | undefined)?.ok === false) {
			set({ error: i18n.t("agentDebugger:refused") });
			return;
		}
	} catch (e) {
		set({ error: (e as Error).message });
		return;
	}
	await get().refresh();
}
