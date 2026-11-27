/** The "For you" inbox of the signed-in person, read once the projects are known. */

import { useCallback } from "react";
import type { ServerProject } from "../api/types";
import { useApi, useSession, useUserId } from "../auth/session";
import { type Loaded, useLoad } from "../hooks/useLoad";
import { type Inbox, loadInbox } from "./forMe";

export function useInbox(projects: readonly ServerProject[] | null): Loaded<Inbox | null> {
	const api = useApi();
	const { can } = useSession();
	const userId = useUserId();
	const load = useCallback(
		async () => (projects ? loadInbox(projects, api.cards, userId, can) : null),
		[projects, api, userId, can],
	);
	return useLoad(load);
}
