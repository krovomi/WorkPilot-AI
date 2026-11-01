/**
 * The phone's colours: the desktop's colour themes (`palettes.ts`), light
 * or dark, as the person chose them (`ThemeProvider.tsx`). Every screen
 * reads its palette with `useTheme()`.
 */

import { createContext, useContext } from "react";
import { useColorScheme } from "react-native";
import type { Column } from "../api/types";
import { PALETTES } from "./palettes";
import { type ColorThemeId, DEFAULT_PREFS, type ThemeMode, type ThemePrefs } from "./theme-ids";

export interface Theme {
	dark: boolean;
	background: string;
	surface: string;
	elevated: string;
	text: string;
	textMuted: string;
	textFaint: string;
	accent: string;
	accentSoft: string;
	onAccent: string;
	border: string;
	success: string;
	warning: string;
	danger: string;
	dangerSoft: string;
}

/** The palette of a colour theme in a mode; `system` follows the device's scheme. */
export function paletteFor(colorTheme: ColorThemeId, mode: ThemeMode, deviceScheme: string | null | undefined): Theme {
	const dark = mode === "dark" || (mode === "system" && deviceScheme === "dark");
	const theme = PALETTES[colorTheme] ?? PALETTES.default;
	return dark ? theme.dark : theme.light;
}

export interface ThemeChoice {
	prefs: ThemePrefs;
	/** Apply a choice at once, keep it on the phone, send it to the server. */
	choose(prefs: ThemePrefs): void;
}

/** Outside a provider (a test, a preview): the default theme, following the device. */
export const ThemeContext = createContext<ThemeChoice>({ prefs: DEFAULT_PREFS, choose: () => undefined });

export function useThemeChoice(): ThemeChoice {
	return useContext(ThemeContext);
}

export function useTheme(): Theme {
	const { prefs } = useContext(ThemeContext);
	const scheme = useColorScheme();
	return paletteFor(prefs.colorTheme, prefs.theme, scheme);
}

/** The dot that marks a column. */
export function columnColor(theme: Theme, column: Column): string {
	switch (column) {
		case "in_progress":
		case "queue":
			return theme.accent;
		case "ai_review":
		case "human_review":
			return theme.warning;
		case "done":
		case "pr_created":
			return theme.success;
		case "build_failed":
		case "error":
			return theme.danger;
		default:
			return theme.textFaint;
	}
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 6, md: 10, lg: 14 } as const;
