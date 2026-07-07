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
			const { sessions } = await window.electronAPI.listDebugSessions();
			set({ sessions });
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
		await window.electronAPI.detachDebugger(sessionId);
		set({ sessionId: null, breakpoints: [], frames: [] });
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
			const { breakpoints, frames } =
				await window.electronAPI.getDebugState(sessionId);
			set({ breakpoints, frames });
		} catch (e) {
			set({ error: (e as Error).message });
		}
	},

	addBreakpoint: async (bp) => {
		const { sessionId } = get();
		if (!sessionId) return;
		await window.electronAPI.setBreakpoint(sessionId, bp);
		await get().refresh();
	},

	removeBreakpoint: async (id) => {
		const { sessionId } = get();
		if (!sessionId) return;
		await window.electronAPI.removeBreakpoint(sessionId, id);
		await get().refresh();
	},

	resume: async (frameId, action, options) => {
		const { sessionId } = get();
		if (!sessionId) return;
		await window.electronAPI.resumeFrame(sessionId, frameId, action, options);
		await get().refresh();
	},
}));
