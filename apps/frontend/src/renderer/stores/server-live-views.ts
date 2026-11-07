/**
 * Server mode: a shared view of a server project read again when a teammate
 * changes it. The main process follows the project's live stream while the
 * view is shown (`hooks/useServerViewLive.ts`, `main/server-live-views.ts`)
 * and says which view changed; the view's own loader reads it again, fresh
 * from the server.
 *
 * Registered once for the window by `global-listeners.ts`. A change for a
 * project no longer shown is dropped, and a view busy with work of its own
 * (a generation it follows, an answer being written) is left alone: that
 * work reads the view when it ends.
 */

import type { ServerViewChange } from "../../shared/types";
import {
	loadProjectContext,
	loadRecentMemories,
	useContextStore,
} from "./context-store";
import { loadIdeation, useIdeationStore } from "./ideation-store";
import {
	loadInsightsSession,
	loadInsightsSessions,
	useInsightsStore,
} from "./insights-store";
import { useProjectStore } from "./project-store";
import { loadRoadmap, useRoadmapStore } from "./roadmap-store";

const ROADMAP_AT_REST = new Set(["idle", "complete", "error"]);
const INSIGHTS_BUSY = new Set(["thinking", "streaming"]);

/** Read again the view a teammate changed, when it is the one shown. */
export async function refreshServerView(change: ServerViewChange): Promise<void> {
	const { activeProjectId, selectedProjectId } = useProjectStore.getState();
	const projectId = change.projectId;
	if ((activeProjectId || selectedProjectId) !== projectId) return;
	switch (change.view) {
		case "roadmap": {
			const roadmap = useRoadmapStore.getState();
			if (roadmap.currentProjectId !== projectId) return;
			if (!ROADMAP_AT_REST.has(roadmap.generationStatus.phase)) return;
			// Also follows a generation a teammate just started.
			await loadRoadmap(projectId);
			return;
		}
		case "ideation": {
			const ideation = useIdeationStore.getState();
			if (ideation.currentProjectId !== projectId || ideation.isGenerating) return;
			await loadIdeation(projectId);
			return;
		}
		case "insights": {
			const insights = useInsightsStore.getState();
			const shown = insights.session?.id;
			if (
				change.sessionId &&
				change.sessionId === shown &&
				!INSIGHTS_BUSY.has(insights.status.phase)
			) {
				// Also lists the conversations again.
				await loadInsightsSession(projectId);
			} else {
				await loadInsightsSessions(projectId);
			}
			return;
		}
		case "context": {
			const context = useContextStore.getState();
			if (change.memoriesOnly) {
				if (!context.memoriesLoading) await loadRecentMemories(projectId);
			} else if (!context.indexLoading) {
				await loadProjectContext(projectId);
			}
			return;
		}
	}
}

export function setupServerViewListeners(): (() => void) | undefined {
	return window.electronAPI.onServerViewChanged?.((change) => {
		refreshServerView(change).catch(() => {
			// Unreachable server: the view keeps what it shows.
		});
	});
}
