/**
 * The roadmap of a server project (server mode). Its file is the server's
 * (`.workpilot/roadmap/` on the clone); the handlers work on the project's
 * mirror, read fresh from the server first, and send back what they change
 * (`server-features.ts`). Turning a feature into a card is the server's own
 * route, so the card lands on the shared board.
 */

import type { IPCResult, Project, Task } from "../../../shared/types";
import { projectStore } from "../../project-store";
import { serverCardTask } from "../../server-board-actions";
import { authedFetch } from "../../server-connection";
import { pullFeature, pushFeatureFile } from "../../server-features";
import { getServerProject } from "../../server-projects";

/** A project of this computer, or one of the server as last listed. */
export function roadmapProject(projectId: unknown): Project | undefined {
	return (
		(typeof projectId === "string" ? projectStore.getProject(projectId) : undefined) ??
		getServerProject(projectId)
	);
}

/**
 * For a server project, read its roadmap into the mirror; the error when the
 * server cannot be read. Nothing to do for a local project.
 */
export async function refreshServerRoadmap(project: Project): Promise<string | null> {
	if (!project.remote) return null;
	const pulled = await pullFeature(project, "roadmap");
	return pulled.success ? null : (pulled.error ?? "Server unavailable");
}

/** Send the mirrored roadmap a handler just changed (server projects only). */
export async function saveServerRoadmap(project: Project): Promise<IPCResult> {
	if (!project.remote) return { success: true };
	return pushFeatureFile(project, "roadmap", "roadmap.json");
}

/** A roadmap feature made a card of the server's board, and linked to it. */
export async function convertOnServer(
	project: Project,
	featureId: unknown,
): Promise<IPCResult<Task>> {
	if (typeof featureId !== "string" || !featureId || featureId.length > 120) {
		return { success: false, error: "Feature not found" };
	}
	const result = await authedFetch<{ card?: { id?: unknown } }>(
		`/api/features/roadmap/features/${encodeURIComponent(featureId)}/convert?project_id=${encodeURIComponent(project.id)}`,
		"POST",
	);
	if (!result.ok) return { success: false, error: result.error };
	await pullFeature(project, "roadmap");
	const cardId = result.data?.card?.id;
	if (typeof cardId !== "string") {
		return { success: false, error: "Unexpected answer from the server" };
	}
	return serverCardTask(project, cardId);
}
