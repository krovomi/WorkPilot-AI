/**
 * What a person chooses for the interface, as the desktop names it
 * (`AppSettings.theme` and `colorTheme`) and as the server stores it
 * (`/users/me/preferences`): one mode and one colour theme.
 */

/** The desktop's colour theme ids (`COLOR_THEMES` in `shared/constants/themes.ts`). */
export const COLOR_THEME_IDS = ["default", "dusk", "lime", "ocean", "retro", "neo", "forest"] as const;
export type ColorThemeId = (typeof COLOR_THEME_IDS)[number];

/** A fixed mode, or the device's. */
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface ThemePrefs {
	theme: ThemeMode;
	colorTheme: ColorThemeId;
}

export const DEFAULT_PREFS: ThemePrefs = { theme: "system", colorTheme: "default" };

export function isColorThemeId(value: unknown): value is ColorThemeId {
	return typeof value === "string" && (COLOR_THEME_IDS as readonly string[]).includes(value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
	return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** Valid preferences from anything (a stored copy, a server answer), or null. */
export function parsePrefs(value: unknown): ThemePrefs | null {
	if (!value || typeof value !== "object") return null;
	const { theme, colorTheme } = value as Record<string, unknown>;
	return isThemeMode(theme) && isColorThemeId(colorTheme) ? { theme, colorTheme } : null;
}
