/**
 * Individual idea operations (update, dismiss, etc.)
 *
 * Each one reads `ideation.json`, changes it and writes it back. For a server
 * project (server mode) the file is read fresh from the server first and the
 * change is sent back with the version it started from, so a teammate's
 * change is never overwritten (`../server-feature-files.ts`).
 */

import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";
import type { IdeationStatus, IPCResult } from "../../../shared/types";
import {
	featureProject,
	refreshServerFeature,
	saveServerFeature,
} from "../server-feature-files";
import {
	readIdeationFile,
	updateIdeationTimestamp,
	writeIdeationFile,
} from "./file-utils";
import type { RawIdeationData } from "./types";

/**
 * Read the project's ideation, apply `edit`, and write it back when the edit
 * succeeded. `failure` is the error when writing throws.
 */
async function editIdeation<T = unknown>(
	projectId: string,
	failure: string,
	edit: (ideation: RawIdeationData) => IPCResult<T>,
): Promise<IPCResult<T>> {
	const project = featureProject(projectId);
	if (!project) {
		return { success: false, error: "Project not found" };
	}
	const unreadable = await refreshServerFeature(project, "ideation");
	if (unreadable) {
		return { success: false, error: unreadable };
	}

	const ideationPath = path.join(
		project.path,
		AUTO_BUILD_PATHS.IDEATION_DIR,
		AUTO_BUILD_PATHS.IDEATION_FILE,
	);

	const ideation = readIdeationFile(ideationPath);
	if (!ideation) {
		return { success: false, error: "Ideation not found" };
	}

	let result: IPCResult<T>;
	try {
		result = edit(ideation);
		if (!result.success) return result;
		updateIdeationTimestamp(ideation);
		writeIdeationFile(ideationPath, ideation);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : failure,
		};
	}
	const saved = await saveServerFeature(
		project,
		"ideation",
		AUTO_BUILD_PATHS.IDEATION_FILE,
	);
	return saved.success ? result : { success: false, error: saved.error };
}

/** Set one idea's status. */
function setStatus(
	projectId: string,
	ideaId: string,
	status: IdeationStatus,
	failure: string,
): Promise<IPCResult> {
	return editIdeation(projectId, failure, (ideation) => {
		const idea = ideation.ideas?.find((i) => i.id === ideaId);
		if (!idea) {
			return { success: false, error: "Idea not found" };
		}
		idea.status = status;
		return { success: true };
	});
}

/**
 * Update an idea's status
 */
export async function updateIdeaStatus(
	_event: IpcMainInvokeEvent,
	projectId: string,
	ideaId: string,
	status: IdeationStatus,
): Promise<IPCResult> {
	return setStatus(projectId, ideaId, status, "Failed to update idea");
}

/**
 * Dismiss a single idea
 */
export async function dismissIdea(
	_event: IpcMainInvokeEvent,
	projectId: string,
	ideaId: string,
): Promise<IPCResult> {
	return setStatus(projectId, ideaId, "dismissed", "Failed to dismiss idea");
}

/**
 * Dismiss all ideas in a session
 */
export async function dismissAllIdeas(
	_event: IpcMainInvokeEvent,
	projectId: string,
): Promise<IPCResult> {
	return editIdeation(projectId, "Failed to dismiss all ideas", (ideation) => {
		// Dismiss all ideas that are not already dismissed or converted
		let dismissedCount = 0;
		ideation.ideas?.forEach((idea) => {
			if (idea.status !== "dismissed" && idea.status !== "converted") {
				idea.status = "dismissed";
				dismissedCount++;
			}
		});
		return { success: true, data: { dismissedCount } };
	});
}

/**
 * Archive a single idea (typically when converted to task)
 */
export async function archiveIdea(
	_event: IpcMainInvokeEvent,
	projectId: string,
	ideaId: string,
): Promise<IPCResult> {
	return setStatus(projectId, ideaId, "archived", "Failed to archive idea");
}

/**
 * Delete a single idea permanently
 */
export async function deleteIdea(
	_event: IpcMainInvokeEvent,
	projectId: string,
	ideaId: string,
): Promise<IPCResult> {
	return editIdeation(projectId, "Failed to delete idea", (ideation) => {
		const ideaIndex = ideation.ideas?.findIndex((i) => i.id === ideaId);
		if (ideaIndex === undefined || ideaIndex === -1) {
			return { success: false, error: "Idea not found" };
		}
		ideation.ideas?.splice(ideaIndex, 1);
		return { success: true };
	});
}

/**
 * Delete multiple ideas permanently
 */
export async function deleteMultipleIdeas(
	_event: IpcMainInvokeEvent,
	projectId: string,
	ideaIds: string[],
): Promise<IPCResult> {
	return editIdeation(projectId, "Failed to delete ideas", (ideation) => {
		const idsToDelete = new Set(ideaIds);
		const originalCount = ideation.ideas?.length || 0;
		ideation.ideas =
			ideation.ideas?.filter((idea) => !idsToDelete.has(idea.id)) || [];
		const deletedCount = originalCount - (ideation.ideas?.length || 0);
		return { success: true, data: { deletedCount } };
	});
}
