/**
 * The signed-in session, for every screen: the client of the server, the
 * person, the organizations they belong to and the one they act in.
 *
 * At launch the stored refresh token is exchanged for a new pair; a refused
 * token signs the person out, an unreachable server leaves the session
 * stored and offers to try again (a phone loses its network often, and
 * signing out on a tunnel would be a poor answer).
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, ServerClient } from "../api/client";
import { type Api, api } from "../api/endpoints";
import type { MyPermissions, ServerUser, TokenResponse } from "../api/types";
import { unregisterFromPush } from "../push/push";
import { clearSession, loadSession, saveSession } from "./token-store";

export type SessionStatus = "loading" | "signedOut" | "unreachable" | "signedIn";

export interface Session {
	status: SessionStatus;
	serverUrl: string | null;
	user: ServerUser | null;
	permissions: MyPermissions | null;
	client: ServerClient | null;
	api: Api | null;
	signIn(serverUrl: string, email: string, password: string): Promise<void>;
	/** Sign in with the id_token of a Microsoft Entra account (`auth/entra.ts`). */
	signInWithEntra(serverUrl: string, idToken: string): Promise<void>;
	signOut(): Promise<void>;
	switchOrg(orgId: string): Promise<void>;
	retry(): Promise<void>;
	/** Whether the person holds a permission in the organization they act in. */
	can(permission: string): boolean;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
	const session = useContext(SessionContext);
	if (!session) throw new Error("useSession outside SessionProvider");
	return session;
}

/** The api of a signed-in session; screens under the signed-in stack only. */
export function useApi(): Api {
	const { api: current } = useSession();
	if (!current) throw new Error("useApi without a session");
	return current;
}

export function SessionProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<SessionStatus>("loading");
	const [serverUrl, setServerUrl] = useState<string | null>(null);
	const [user, setUser] = useState<ServerUser | null>(null);
	const [permissions, setPermissions] = useState<MyPermissions | null>(null);
	const [client, setClient] = useState<ServerClient | null>(null);
	const clientRef = useRef<ServerClient | null>(null);

	const makeClient = useCallback((baseUrl: string, refreshToken: string | null, orgId: string | null) => {
		const created = new ServerClient({
			baseUrl,
			refreshToken,
			orgId,
			onTokens: (tokens: TokenResponse) => {
				setUser(tokens.user);
				void saveSession({ refreshToken: tokens.refresh_token });
			},
			onSignedOut: () => {
				void clearSession();
				setUser(null);
				setPermissions(null);
				setStatus("signedOut");
			},
		});
		clientRef.current = created;
		setClient(created);
		return created;
	}, []);

	/** Read what the person may do, adopting the organization the server resolved. */
	const loadPermissions = useCallback(async (current: ServerClient) => {
		const mine = await api(current).permissions();
		if (!current.activeOrgId && mine.org_id) {
			current.setOrg(mine.org_id);
			await saveSession({ orgId: mine.org_id });
		}
		setPermissions(mine);
		setStatus("signedIn");
	}, []);

	const resume = useCallback(async () => {
		setStatus("loading");
		const stored = await loadSession();
		setServerUrl(stored.serverUrl);
		if (!stored.serverUrl || !stored.refreshToken) {
			setStatus("signedOut");
			return;
		}
		const current = makeClient(stored.serverUrl, stored.refreshToken, stored.orgId);
		try {
			if (!(await current.refresh())) {
				setStatus("signedOut");
				return;
			}
			await loadPermissions(current);
		} catch (err) {
			setStatus(err instanceof ApiError && err.status === 401 ? "signedOut" : "unreachable");
		}
	}, [makeClient, loadPermissions]);

	useEffect(() => {
		void resume();
	}, [resume]);

	const signIn = useCallback(
		async (url: string, email: string, password: string) => {
			const current = makeClient(url, null, null);
			await current.login(email, password);
			await saveSession({ serverUrl: url, orgId: null });
			setServerUrl(url);
			await loadPermissions(current);
		},
		[makeClient, loadPermissions],
	);

	const signInWithEntra = useCallback(
		async (url: string, idToken: string) => {
			const current = makeClient(url, null, null);
			await current.loginWithEntra(idToken);
			await saveSession({ serverUrl: url, orgId: null });
			setServerUrl(url);
			await loadPermissions(current);
		},
		[makeClient, loadPermissions],
	);

	const signOut = useCallback(async () => {
		const current = clientRef.current;
		// While the session can still call the server: this phone stops
		// receiving the person's notifications.
		await unregisterFromPush(current ? api(current) : null);
		if (current) await current.logout();
		await clearSession();
		setUser(null);
		setPermissions(null);
		setStatus("signedOut");
	}, []);

	const switchOrg = useCallback(
		async (orgId: string) => {
			const current = clientRef.current;
			if (!current) return;
			await current.switchOrg(orgId);
			await saveSession({ orgId });
			await loadPermissions(current);
		},
		[loadPermissions],
	);

	const value = useMemo<Session>(
		() => ({
			status,
			serverUrl,
			user,
			permissions,
			client,
			api: client ? api(client) : null,
			signIn,
			signInWithEntra,
			signOut,
			switchOrg,
			retry: resume,
			can: (permission) => !!permissions?.is_platform_admin || !!permissions?.permissions.includes(permission),
		}),
		[status, serverUrl, user, permissions, client, signIn, signInWithEntra, signOut, switchOrg, resume],
	);

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
