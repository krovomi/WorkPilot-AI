import { useEffect } from "react";
import type { ServerLiveView } from "../../shared/types";
import { useProjectStore } from "../stores/project-store";

/**
 * Keeps a shared view of a server project live while it is shown (server
 * mode): the main process holds the project's stream for it, one reference
 * per shown view, and a teammate's change is read at once
 * (`stores/server-live-views.ts`). Nothing for a project of this computer.
 */
export function useServerViewLive(projectId: string, view: ServerLiveView): void {
	const isServerProject = useProjectStore((state) =>
		Boolean(state.projects.find((project) => project.id === projectId)?.remote),
	);
	useEffect(() => {
		if (!isServerProject) return;
		const api = globalThis.electronAPI;
		void api.watchServerView?.(projectId, view);
		return () => {
			void api.unwatchServerView?.(projectId, view);
		};
	}, [projectId, view, isServerProject]);
}
