/**
 * Server session store — multi-user server mode state in the renderer.
 *
 * Mirrors the main-process server-connection state (mode, server URL,
 * authenticated user) and exposes the login/logout actions. The renderer
 * never sees the tokens themselves; they stay in the main process.
 */
import { create } from "zustand";
import { usePermissionsStore } from "./permissions-store";
import { refreshProjects } from "./project-store";
import { useSettingsStore } from "./settings-store";

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
	configured: boolean;
	isLoginScreenOpen: boolean;
	initialized: boolean;
	/**
	 * True once the persisted session has been read and the connection gate
	 * decided (shown or not). Until then nothing else may open over the gate:
	 * the first-run wizard would cover the local/server choice.
	 */
	sessionResolved: boolean;

	initialize: () => Promise<void>;
	openLoginScreen: () => void;
	closeLoginScreen: () => void;
	loginLocal: (
		serverUrl: string,
		email: string,
		password: string,
	) => Promise<{ ok: boolean; error?: string }>;
	loginEntra: (serverUrl: string) => Promise<{ ok: boolean; error?: string }>;
	lookupInvite: (
		serverUrl: string,
		token: string,
	) => Promise<{ ok: boolean; email?: string; error?: string }>;
	acceptInvite: (
		serverUrl: string,
		token: string,
		displayName: string,
		password: string,
	) => Promise<{ ok: boolean; error?: string }>;
	// Named switchTo* (not use*) so lint hook rules don't mistake the store
	// action for a React hook at call sites.
	switchToLocalMode: () => Promise<void>;
	logout: () => Promise<void>;
}

/**
 * Apply the theme the server keeps for the person (main already wrote it in
 * the settings file); nothing when the server has none or cannot be reached.
 */
async function applyServerTheme(): Promise<void> {
	try {
		const prefs = await window.electronAPI.serverAuth.pullUiPreferences?.();
		if (prefs) useSettingsStore.getState().updateSettings(prefs);
	} catch {
		// The desktop's own theme stays.
	}
}

type AuthStatePayload = {
	mode: "local" | "server";
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	configured: boolean;
};

export const useServerSessionStore = create<ServerSessionState>((set, get) => {
	// Whose server projects the project list holds: when the session changes,
	// the list is read again so it shows this user's projects and no one else's.
	let projectsSession: string | null = null;

	const applyState = (state: AuthStatePayload) => {
		set({
			mode: state.mode,
			serverUrl: state.serverUrl,
			user: state.user,
			isAuthenticated: state.isAuthenticated,
			configured: state.configured,
		});

		// Effective permissions belong to a session: resolve them when one
		// starts, and drop them when it ends, so the UI never keeps masking
		// (or unmasking) against the previous user's rights.
		const permissions = usePermissionsStore.getState();
		if (state.mode === "server" && state.isAuthenticated) {
			void permissions.load();
		} else {
			permissions.reset();
		}
		const session =
			state.mode === "server" && state.isAuthenticated
				? `${state.serverUrl}|${state.user?.id ?? ""}`
				: null;
		if (session !== projectsSession) {
			const first = projectsSession === null && session === null;
			projectsSession = session;
			if (!first) void refreshProjects();
			// The person's theme from the server, the same as on their phone.
			if (session !== null) void applyServerTheme();
		}
	};

	return {
		mode: "local",
		serverUrl: null,
		user: null,
		isAuthenticated: false,
		configured: false,
		isLoginScreenOpen: false,
		initialized: false,
		sessionResolved: false,

		initialize: async () => {
			if (get().initialized) return;
			set({ initialized: true });
			try {
				// Attempt to restore a persisted session first (auto-login from the
				// encrypted refresh token), then decide whether to show the gate.
				const state = await window.electronAPI.serverAuth.restore();
				applyState(state);
				window.electronAPI.serverAuth.onStateChanged(applyState);
				if (state.isAuthenticated) {
					set({ isLoginScreenOpen: false });
				} else if (state.mode === "server") {
					// Server configured but session expired -> ask to log in again.
					set({ isLoginScreenOpen: true });
				} else if (!state.configured) {
					// First launch, no choice made yet -> show the connection gate.
					set({ isLoginScreenOpen: true });
				}
			} catch (err) {
				console.error("[server-session] init failed:", err);
			} finally {
				set({ sessionResolved: true });
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

		lookupInvite: async (serverUrl, token) => {
			const result = await window.electronAPI.serverAuth.lookupInvite(
				serverUrl,
				token,
			);
			if (result.ok) return { ok: true, email: result.data.email };
			return { ok: false, error: result.error };
		},

		acceptInvite: async (serverUrl, token, displayName, password) => {
			const result = await window.electronAPI.serverAuth.acceptInvite(
				serverUrl,
				token,
				displayName,
				password,
			);
			if (result.ok) {
				set({ isLoginScreenOpen: false });
				return { ok: true };
			}
			return { ok: false, error: result.error };
		},

		switchToLocalMode: async () => {
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
