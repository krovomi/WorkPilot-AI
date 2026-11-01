/**
 * The person's theme on the server (server mode), so that the desktop and
 * the phone show the same one: `GET/PUT /users/me/preferences`
 * (`apps/backend/server/routers/preferences.py`).
 *
 * At connection the renderer asks for the server's choice; when it has one,
 * it replaces the desktop's (written to the settings file here, applied by
 * the renderer). When the person changes their theme in the settings,
 * SETTINGS_SAVE sends it. Both are best effort: a server that cannot be
 * reached, or that predates the route, leaves the desktop's local choice.
 * Only the two closed lists cross, checked on the way in and out.
 */

import { COLOR_THEMES } from "../shared/constants/themes";
import type { AppSettings, ColorTheme } from "../shared/types/settings";
import { authedFetch, getAccessToken, isServerMode } from "./server-connection";
import { readSettingsFile, writeSettingsFile } from "./settings-utils";

export interface UiPreferences {
	theme: AppSettings["theme"];
	colorTheme: ColorTheme;
}

const PATH = "/users/me/preferences";
const MODES: ReadonlySet<string> = new Set(["light", "dark", "system"]);
const COLORS: ReadonlySet<string> = new Set(COLOR_THEMES.map((theme) => theme.id));

/** Both values from the closed lists, or null. */
export function parseUiPreferences(value: unknown): UiPreferences | null {
	if (!value || typeof value !== "object") return null;
	const { theme, colorTheme } = value as Record<string, unknown>;
	if (typeof theme !== "string" || !MODES.has(theme)) return null;
	if (typeof colorTheme !== "string" || !COLORS.has(colorTheme)) return null;
	return {
		theme: theme as UiPreferences["theme"],
		colorTheme: colorTheme as ColorTheme,
	};
}

function connected(): boolean {
	return isServerMode() && getAccessToken() !== null;
}

/** Send the desktop's choice; whether the server took it. */
export async function pushServerUiPreferences(prefs: UiPreferences): Promise<boolean> {
	const valid = parseUiPreferences(prefs);
	if (!valid || !connected()) return false;
	const result = await authedFetch(PATH, "PUT", valid);
	return result.ok;
}

/**
 * After SETTINGS_SAVE: when the update touched the theme, send the saved
 * pair, without holding the save up nor failing it.
 */
export function pushThemeIfChanged(
	update: Partial<AppSettings>,
	saved: Partial<AppSettings>,
): void {
	if (update.theme === undefined && update.colorTheme === undefined) return;
	if (!connected()) return;
	void pushServerUiPreferences({
		theme: saved.theme ?? "system",
		colorTheme: saved.colorTheme ?? "default",
	}).catch(() => false);
}

/**
 * At connection: the server's choice, kept in the settings file when it
 * differs from the desktop's. Null when there is nothing to apply (no
 * session, no choice on the server, the server unreachable).
 */
export async function pullServerUiPreferences(): Promise<UiPreferences | null> {
	if (!connected()) return null;
	const result = await authedFetch<unknown>(PATH, "GET");
	if (!result.ok) return null;
	const remote = parseUiPreferences(result.data);
	const current = readSettingsFile() ?? {};
	if (!remote) {
		// The server has no choice yet: it takes the desktop's.
		const local = parseUiPreferences({
			theme: current.theme ?? "system",
			colorTheme: current.colorTheme ?? "default",
		});
		if (local) await pushServerUiPreferences(local);
		return null;
	}
	if (current.theme !== remote.theme || current.colorTheme !== remote.colorTheme) {
		writeSettingsFile({ ...current, ...remote });
	}
	return remote;
}
