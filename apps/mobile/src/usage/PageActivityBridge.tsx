/**
 * Mounted once under the signed-in stack: each screen the person opens is
 * counted for the server's page activity (`page-activity.ts`), by its name
 * in `pages.ts` only, and only while their organization turned it on. The
 * counts go every few minutes and when the app goes to the background.
 */

import { useSegments } from "expo-router";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { useSession } from "../auth/session";
import { PageActivity } from "./page-activity";
import { pageOf } from "./pages";

export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export function PageActivityBridge() {
	const { api, user, permissions } = useSession();
	const segments = useSegments();
	const owner = user ? `${user.id}@${permissions?.org_id ?? ""}` : null;
	// One counter per person and organization: another one starts from nothing.
	const activity = useMemo(() => (api && owner ? new PageActivity(api, owner) : null), [api, owner]);
	const page = pageOf(segments);

	useEffect(() => {
		if (activity && page) void activity.note(page);
	}, [activity, page]);

	useEffect(() => {
		if (!activity) return;
		const timer = setInterval(() => void activity.flush(), FLUSH_INTERVAL_MS);
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") void activity.flush();
		});
		// Signed out or another organization: what was not sent is dropped,
		// never sent under the next one.
		return () => {
			clearInterval(timer);
			listener.remove();
		};
	}, [activity]);

	return null;
}
