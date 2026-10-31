/**
 * What every shared feature's handlers do for a server project (server
 * mode): find the project (one of this computer, or of the server), read the
 * feature's files fresh into the mirror, send back the file a handler changed,
 * and turn one of its items into a card of the server's board.
 *
 * The files and their versions are `server-features.ts`; a local project
 * passes through each helper untouched.
 */

import type { IPCResult, Project, Task } from "../../shared/types";
import { projectStore } from "../project-store";
import { serverCardTask } from "../server-board-actions";
import { authedFetch } from "../server-connection";
import {
	pullFeature,
	pushFeatureFile,
	type SharedFeature,
} from "../server-features";
import { getServerProject } from "../server-projects";

const ITEM_ID_MAX = 120;

/** A project of this computer, or one of the server as last listed. */
export function featureProject(projectId: unknown): Project | undefined {
	return (
		(typeof projectId === "string"
			? projectStore.getProject(projectId)
			: undefined) ?? getServerProject(projectId)
	);
}

/**
 * For a server project, read a feature's files into the mirror; the error
 * when the server cannot be read. Nothing to do for a local project.
 */
export async function refreshServerFeature(
	project: Project,
	feature: SharedFeature,
): Promise<string | null> {
	if (!project.remote) return null;
	const pulled = await pullFeature(project, feature);
	return pulled.success ? null : (pulled.error ?? "Server unavailable");
}

/** Send a mirrored file a handler just changed (server projects only). */
export async function saveServerFeature(
	project: Project,
	feature: SharedFeature,
	name: string,
): Promise<IPCResult> {
	if (!project.remote) return { success: true };
	return pushFeatureFile(project, feature, name);
}

/**
 * An item of a feature (a roadmap feature, an idea) made a card of the
 * server's board, by the feature's own route, and linked to it there.
 */
export async function convertOnServer(
	project: Project,
	feature: SharedFeature,
	collection: "features" | "ideas",
	itemId: unknown,
	notFound: string,
): Promise<IPCResult<Task>> {
	if (typeof itemId !== "string" || !itemId || itemId.length > ITEM_ID_MAX) {
		return { success: false, error: notFound };
	}
	const result = await authedFetch<{ card?: { id?: unknown } }>(
		`/api/features/${feature}/${collection}/${encodeURIComponent(itemId)}/convert?project_id=${encodeURIComponent(project.id)}`,
		"POST",
	);
	if (!result.ok) return { success: false, error: result.error };
	await pullFeature(project, feature);
	const cardId = result.data?.card?.id;
	if (typeof cardId !== "string") {
		return { success: false, error: "Unexpected answer from the server" };
	}
	return serverCardTask(project, cardId);
}
