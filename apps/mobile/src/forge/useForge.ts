/** The project's forge on screen: its record read once, then the adapter for its kind. */

import { useCallback, useMemo } from "react";
import { useApi, useSession } from "../auth/session";
import { useLoad } from "../hooks/useLoad";
import { type Forge, makeForge } from "./forge";
import type { ForgeKind } from "./types";

export function forgeKind(forge: string | null | undefined): ForgeKind | null {
	return forge === "github" || forge === "gitlab" ? forge : null;
}

export function useProject(projectId: string) {
	const api = useApi();
	const load = useCallback(() => api.project(projectId), [api, projectId]);
	return useLoad(load);
}

export function useForge(projectId: string): { forge: Forge | null; loading: boolean; error: unknown } {
	const { client } = useSession();
	const project = useProject(projectId);
	const forge = useMemo(() => {
		const kind = forgeKind(project.data?.forge);
		return client && kind && project.data ? makeForge(client, projectId, kind, project.data.repo_url) : null;
	}, [client, project.data, projectId]);
	return { forge, loading: project.loading, error: project.error };
}
