/**
 * The task form's "Mobile platforms" box, for a project of this computer or
 * of the WorkPilot server (server mode).
 *
 * The answer is `apps/backend/mobile/bootstrap.py`'s, wherever it runs: the
 * mobile runner on a local clone, `GET /api/board/mobile-profile` on the
 * server's clone. The renderer names a project by id, never a path (S6).
 */

import type { MobileProfile } from "../shared/types/mobile";
import { mobileService } from "./mobile-service";
import { projectStore } from "./project-store";
import { authedFetch } from "./server-connection";
import { getServerProject } from "./server-projects";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function getMobileProfile(projectId: unknown): Promise<MobileProfile> {
	if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
		return { success: false, isMobile: false, error: "Invalid project" };
	}
	const server = getServerProject(projectId);
	if (server) {
		const result = await authedFetch<MobileProfile>(
			`/api/board/mobile-profile?project_id=${encodeURIComponent(server.id)}`,
			"GET",
		);
		return result.ok
			? result.data
			: { success: false, isMobile: false, error: result.error };
	}
	const project = projectStore.getProject(projectId);
	if (!project?.path) {
		return { success: false, isMobile: false, error: "Project not found" };
	}
	return mobileService.profile(project.path);
}
