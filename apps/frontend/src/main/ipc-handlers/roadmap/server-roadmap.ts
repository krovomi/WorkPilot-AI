/**
 * The roadmap of a server project (server mode). Its file is the server's
 * (`.workpilot/roadmap/` on the clone); the handlers work on the project's
 * mirror, read fresh from the server first, and send back what they change
 * (`../server-feature-files.ts`). Turning a feature into a card is the
 * server's own route, so the card lands on the shared board.
 */

import type { IPCResult, Project, Task } from "../../../shared/types";
import {
	convertOnServer as convertItemOnServer,
	featureProject,
	refreshServerFeature,
	saveServerFeature,
} from "../server-feature-files";

/** A project of this computer, or one of the server as last listed. */
export const roadmapProject = featureProject;

/** For a server project, read its roadmap into the mirror. */
export function refreshServerRoadmap(project: Project): Promise<string | null> {
	return refreshServerFeature(project, "roadmap");
}

/** Send the mirrored roadmap a handler just changed (server projects only). */
export function saveServerRoadmap(project: Project): Promise<IPCResult> {
	return saveServerFeature(project, "roadmap", "roadmap.json");
}

/** A roadmap feature made a card of the server's board, and linked to it. */
export function convertOnServer(
	project: Project,
	featureId: unknown,
): Promise<IPCResult<Task>> {
	return convertItemOnServer(
		project,
		"roadmap",
		"features",
		featureId,
		"Feature not found",
	);
}
