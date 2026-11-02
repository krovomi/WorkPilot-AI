/**
 * The person's theme for the whole app: every `useTheme()`, the native
 * Stack headers and the navigation's colours change together when it does.
 *
 * At launch the phone's copy applies before any network (`theme-store.ts`);
 * once signed in, the copy is reconciled with the account's on the server
 * (`theme-sync.ts`), once per person. A choice in Settings applies at once,
 * is kept on the phone and sent to the server; offline, it waits for the
 * next sign-in or launch.
 */

import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../auth/session";
import { type Theme, ThemeContext, type ThemeChoice, useTheme } from "./theme";
import { DEFAULT_PREFS, type ThemePrefs } from "./theme-ids";
import { loadPrefs, type StoredPrefs, savePrefs } from "./theme-store";
import { pushPrefs, syncPrefs } from "./theme-sync";

/** React Navigation's theme from a palette (card transitions, default headers). */
export function navigationTheme(theme: Theme): ReactNavigation.Theme {
	const base = theme.dark ? DarkTheme : DefaultTheme;
	return {
		...base,
		dark: theme.dark,
		colors: {
			...base.colors,
			primary: theme.accent,
			background: theme.background,
			card: theme.surface,
			text: theme.text,
			border: theme.border,
			notification: theme.danger,
		},
	};
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const { status, api, user, permissions } = useSession();
	const [prefs, setPrefs] = useState<ThemePrefs>(DEFAULT_PREFS);
	const stored = useRef<StoredPrefs | null>(null);
	const loaded = useRef<Promise<void> | null>(null);
	const syncedFor = useRef<string | null>(null);

	const apply = useCallback((next: StoredPrefs) => {
		stored.current = next;
		setPrefs({ theme: next.theme, colorTheme: next.colorTheme });
		void savePrefs(next);
	}, []);

	if (loaded.current === null) {
		loaded.current = loadPrefs().then((copy) => {
			// A choice made while the copy was being read is newer: keep it.
			if (copy && stored.current === null) {
				stored.current = copy;
				setPrefs({ theme: copy.theme, colorTheme: copy.colorTheme });
			}
		});
	}

	const signedIn = status === "signedIn" && api !== null;
	const who = user?.id ?? permissions?.user_id ?? null;
	useEffect(() => {
		if (!signedIn || !api || !who) {
			if (status === "signedOut") syncedFor.current = null;
			return;
		}
		if (syncedFor.current === who) return;
		syncedFor.current = who;
		void (async () => {
			await loaded.current;
			const next = await syncPrefs(api, stored.current, who);
			if (next && syncedFor.current === who) apply(next);
		})();
	}, [signedIn, api, who, status, apply]);

	const choose = useCallback(
		(chosen: ThemePrefs) => {
			// Tagged with who made it: a pending choice only ever goes to their account.
			const waiting: StoredPrefs = { ...chosen, pending: true, owner: who };
			apply(waiting);
			if (!signedIn || !api) return;
			void pushPrefs(api, chosen).then((pending) => {
				if (!pending && stored.current === waiting) {
					stored.current = { ...waiting, pending: false };
					void savePrefs(stored.current);
				}
			});
		},
		[apply, signedIn, api, who],
	);

	const value = useMemo<ThemeChoice>(() => ({ prefs, choose }), [prefs, choose]);
	return (
		<ThemeContext.Provider value={value}>
			<NavigationTheme>{children}</NavigationTheme>
		</ThemeContext.Provider>
	);
}

function NavigationTheme({ children }: { children: ReactNode }) {
	const theme = useTheme();
	const value = useMemo(() => navigationTheme(theme), [theme]);
	return <NavigationThemeProvider value={value}>{children}</NavigationThemeProvider>;
}
