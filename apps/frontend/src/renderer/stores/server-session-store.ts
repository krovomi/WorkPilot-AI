/**
 * Server session store — multi-user server mode state in the renderer.
 *
 * Mirrors the main-process server-connection state (mode, server URL,
 * authenticated user) and exposes the login/logout actions. The renderer
 * never sees the tokens themselves; they stay in the main process.
 */
import { create } from "zustand";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

interface ServerSessionState {
	mode: "local" | "server";
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	isLoginScreenOpen: boolean;
	initialized: boolean;

	initialize: () => Promise<void>;
	openLoginScreen: () => void;
	closeLoginScreen: () => void;
	loginLocal: (
		serverUrl: string,
		email: string,
		password: string,
	) => Promise<{ ok: boolean; error?: string }>;
	loginEntra: (serverUrl: string) => Promise<{ ok: boolean; error?: string }>;
	useLocalMode: () => Promise<void>;
	logout: () => Promise<void>;
}

type AuthStatePayload = {
	mode: "local" | "server";
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
};

export const useServerSessionStore = create<ServerSessionState>((set, get) => {
	const applyState = (state: AuthStatePayload) => {
		set({
			mode: state.mode,
			serverUrl: state.serverUrl,
			user: state.user,
			isAuthenticated: state.isAuthenticated,
		});
	};

	return {
		mode: "local",
		serverUrl: null,
		user: null,
		isAuthenticated: false,
		isLoginScreenOpen: false,
		initialized: false,

		initialize: async () => {
			if (get().initialized) return;
			set({ initialized: true });
			try {
				const state = await window.electronAPI.serverAuth.getState();
				applyState(state);
				window.electronAPI.serverAuth.onStateChanged(applyState);
				// Server mode configured but session expired -> ask to log in again.
				if (state.mode === "server" && !state.isAuthenticated) {
					set({ isLoginScreenOpen: true });
				}
			} catch (err) {
				console.error("[server-session] init failed:", err);
			}
		},

		openLoginScreen: () => set({ isLoginScreenOpen: true }),
		closeLoginScreen: () => set({ isLoginScreenOpen: false }),

		loginLocal: async (serverUrl, email, password) => {
			const result = await window.electronAPI.serverAuth.loginLocal(
				serverUrl,
				email,
				password,
			);
			if (result.ok) {
				set({ isLoginScreenOpen: false });
				return { ok: true };
			}
			return { ok: false, error: result.error };
		},

		loginEntra: async (serverUrl) => {
			const result = await window.electronAPI.serverAuth.loginEntra(serverUrl);
			if (result.ok) {
				set({ isLoginScreenOpen: false });
				return { ok: true };
			}
			return { ok: false, error: result.error };
		},

		useLocalMode: async () => {
			const state = await window.electronAPI.serverAuth.setMode("local");
			applyState(state);
			set({ isLoginScreenOpen: false });
		},

		logout: async () => {
			const state = await window.electronAPI.serverAuth.logout();
			applyState(state);
			set({ isLoginScreenOpen: true });
		},
	};
});
