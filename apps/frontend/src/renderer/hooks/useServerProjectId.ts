import { useProjectStore } from "../stores/project-store";

/**
 * The id of the server project a view shows, found by its id or its path (a
 * server project's path is the app's mirror of its board): its workspace
 * views read the server for it, never the mirror nor this computer's files.
 * Undefined for a project of this computer.
 */
export function useServerProjectId(project: {
	id?: string;
	path?: string;
}): string | undefined {
	const { id, path } = project;
	return useProjectStore(
		(state) =>
			state.projects.find(
				(candidate) =>
					Boolean(candidate.remote) &&
					((id !== undefined && candidate.id === id) ||
						(path !== undefined && candidate.path === path)),
			)?.id,
	);
}
