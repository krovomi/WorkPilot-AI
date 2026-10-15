/**
 * A project's `.workpilot/.env` configuration, bound to the project it was
 * read for.
 *
 * The binding is the point. Loading is asynchronous and the selected project
 * can change at any moment, so for a few renders the page holds the *previous*
 * project's configuration while `selectedProjectId` is already the new one.
 * Every save sends the whole configuration (`ENV_UPDATE` keeps what it is not
 * given), so a save fired in that window writes one project's settings into
 * another project's file — and the fields are uncontrolled inputs whose
 * `onBlur` fires exactly then, when the pointer leaves them for the project
 * switcher.
 *
 * That is not hypothetical: a test project with no git remote at all was found
 * holding `GITHUB_REPO=krovomi/WorkPilot-AI`, `GITHUB_AUTO_SYNC=true` and
 * another project's Context7 API key. Before `ENV_GET` learned to mask
 * secrets, the key copied across was the real one.
 *
 * So `envConfig` is **derived**, not stored: it is null unless what was loaded
 * belongs to the project selected right now. A guard in an effect would still
 * leave the render in between; a derived value has no window. Callers keep
 * their usual `if (!envConfig) return` and are safe in every ordering.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import type { ProjectEnvConfig } from "../../shared/types";

export interface LoadedProjectEnv {
	/** The project the configuration was read for. */
	projectId: string;
	config: ProjectEnvConfig;
}

export interface ProjectEnvConfigState {
	/** The selected project's configuration, or null while it is not loaded. */
	envConfig: ProjectEnvConfig | null;
	/** Same shape as a `useState` setter; the result stays bound to the project. */
	setEnvConfig: Dispatch<SetStateAction<ProjectEnvConfig | null>>;
	isLoading: boolean;
}

export function useProjectEnvConfig(
	projectId: string | null | undefined,
	autoBuildPath: string | null | undefined,
): ProjectEnvConfigState {
	const [loaded, setLoaded] = useState<LoadedProjectEnv | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	useEffect(() => {
		if (!projectId || !autoBuildPath) {
			setLoaded(null);
			setIsLoading(false);
			return;
		}
		// A response that arrives after the project changed is dropped rather
		// than stored: the binding below would hide it anyway, and keeping it
		// would have the next switch back to this project show stale values.
		let live = true;
		setIsLoading(true);
		globalThis.electronAPI
			.getProjectEnv(projectId)
			.then((result) => {
				if (!live) return;
				setLoaded(
					result.success && result.data
						? { projectId, config: result.data }
						: null,
				);
			})
			.catch(() => {
				if (live) setLoaded(null);
			})
			.finally(() => {
				if (live) setIsLoading(false);
			});
		return () => {
			live = false;
		};
	}, [projectId, autoBuildPath]);

	const envConfig =
		loaded && projectId && loaded.projectId === projectId ? loaded.config : null;

	const setEnvConfig = useCallback<Dispatch<SetStateAction<ProjectEnvConfig | null>>>(
		(next) => {
			setLoaded((prev) => {
				if (!projectId) return null;
				// An updater sees the *bound* configuration: null when what is
				// loaded belongs to another project, never that project's values.
				const base = prev && prev.projectId === projectId ? prev.config : null;
				const value = typeof next === "function" ? next(base) : next;
				return value ? { projectId, config: value } : null;
			});
		},
		[projectId],
	);

	return { envConfig, setEnvConfig, isLoading };
}
