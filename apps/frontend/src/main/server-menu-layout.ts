/**
 * The person's menu on the server (server mode), so that each person finds
 * the left menu they arranged on any desktop they sign in on:
 * `GET/PUT /users/me/preferences/menu`
 * (`apps/backend/server/routers/preferences.py`).
 *
 * Like the theme (`server-ui-preferences.ts`): at connection the server's
 * layout replaces the desktop's (written to the settings file here, applied
 * by the renderer), and a server without one takes the desktop's; when the
 * person rearranges the menu, SETTINGS_SAVE sends it. Only the layout
 * crosses (order, moves, pins, hidden pages), never which space is open,
 * and it is checked on the way out and on the way in. Best effort: a server
 * that cannot be reached, or that predates the route, leaves the desktop's.
 */

import {
	isDefaultMenuLayout,
	type MenuLayout,
	menuLayoutOf,
	parseMenuLayout,
	sameMenuLayout,
} from "../shared/utils/menu-layout";
import { type AppSettings, DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from "../shared/types/settings";
import { authedFetch, getAccessToken, isServerMode } from "./server-connection";
import { readSettingsFile, writeSettingsFile } from "./settings-utils";
import { pullServerUiPreferences, type UiPreferences } from "./server-ui-preferences";

const PATH = "/users/me/preferences/menu";

function connected(): boolean {
	return isServerMode() && getAccessToken() !== null;
}

/** Send the desktop's layout; whether the server took it. */
export async function pushServerMenuLayout(layout: MenuLayout): Promise<boolean> {
	const valid = parseMenuLayout(layout);
	if (!valid || !connected()) return false;
	const result = await authedFetch(PATH, "PUT", valid);
	return result.ok;
}

/**
 * After SETTINGS_SAVE: when the save changed how the menu is arranged (not
 * only the space open or a snooze), send the new layout, without holding
 * the save up nor failing it.
 */
export function pushMenuLayoutIfChanged(
	update: Partial<AppSettings>,
	previous: Partial<AppSettings>,
	saved: Partial<AppSettings>,
): void {
	if (update.sidebarPrefs === undefined || !connected()) return;
	const before = menuLayoutOf(previous.sidebarPrefs);
	const after = menuLayoutOf(saved.sidebarPrefs);
	if (sameMenuLayout(before, after)) return;
	void pushServerMenuLayout(after).catch(() => false);
}

/**
 * At connection: the sidebar preferences with the server's layout, kept in
 * the settings file when it differs from the desktop's. Null when there is
 * nothing to apply (no session, no layout on the server, the server
 * unreachable or sending something that is not a layout).
 */
export async function pullServerMenuLayout(): Promise<SidebarPrefs | null> {
	if (!connected()) return null;
	const result = await authedFetch<{ layout?: unknown }>(PATH, "GET");
	if (!result.ok) return null;
	const current = (readSettingsFile() ?? {}) as Partial<AppSettings>;
	const local = menuLayoutOf(current.sidebarPrefs);
	if (result.data?.layout === null) {
		// The server has no layout yet: it takes the desktop's, if any.
		if (!isDefaultMenuLayout(local)) await pushServerMenuLayout(local);
		return null;
	}
	const remote = parseMenuLayout(result.data?.layout);
	if (!remote) return null;
	const sidebarPrefs: SidebarPrefs = {
		...DEFAULT_SIDEBAR_PREFS,
		...current.sidebarPrefs,
		...remote,
	};
	if (!sameMenuLayout(local, remote)) writeSettingsFile({ ...current, sidebarPrefs });
	return sidebarPrefs;
}

/**
 * What the renderer applies at connection: the theme, then the menu, read
 * one after the other since both may rewrite the settings file. Null when
 * the server keeps neither.
 */
export async function pullServerInterface(): Promise<
	(Partial<UiPreferences> & { sidebarPrefs?: SidebarPrefs }) | null
> {
	const theme = await pullServerUiPreferences().catch(() => null);
	const sidebarPrefs = await pullServerMenuLayout().catch(() => null);
	if (!theme && !sidebarPrefs) return null;
	return { ...theme, ...(sidebarPrefs ? { sidebarPrefs } : {}) };
}
