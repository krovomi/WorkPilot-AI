/**
 * Ideation session CRUD operations
 */

import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";
import type {
	IdeationSession,
	IPCResult,
	Project,
} from "../../../shared/types";
import { isActiveJob, pullFeature } from "../../server-features";
import { featureProject } from "../server-feature-files";
import { readIdeationFile } from "./file-utils";
import { transformIdeaFromSnakeCase } from "./transformers";

/**
 * Get ideation session for a project. A server project's is read fresh from
 * the server; a job a teammate is running there is handed to `follow`.
 */
export async function getIdeationSession(
	_event: IpcMainInvokeEvent,
	projectId: string,
	follow?: (project: Project, jobId: string) => void,
): Promise<IPCResult<IdeationSession | null>> {
	const project = featureProject(projectId);
	if (!project) {
		return { success: false, error: "Project not found" };
	}
	if (project.remote) {
		const pulled = await pullFeature(project, "ideation");
		if (!pulled.success) {
			return { success: false, error: pulled.error ?? "Server unavailable" };
		}
		const job = pulled.data?.job ?? null;
		if (isActiveJob(job)) follow?.(project, job.id);
	}

	const ideationPath = path.join(
		project.path,
		AUTO_BUILD_PATHS.IDEATION_DIR,
		AUTO_BUILD_PATHS.IDEATION_FILE,
	);

	const rawIdeation = readIdeationFile(ideationPath);
	if (!rawIdeation) {
		return { success: true, data: null };
	}

	try {
		// Transform snake_case to camelCase for frontend
		const enabledTypes = (rawIdeation.config?.enabled_types ||
			rawIdeation.config?.enabledTypes ||
			[]) as unknown[];

		const session: IdeationSession = {
			id: rawIdeation.id || `ideation-${Date.now()}`,
			projectId,
			config: {
				enabledTypes: enabledTypes as IdeationSession["config"]["enabledTypes"],
				includeRoadmapContext:
					rawIdeation.config?.include_roadmap_context ??
					rawIdeation.config?.includeRoadmapContext ??
					true,
				includeKanbanContext:
					rawIdeation.config?.include_kanban_context ??
					rawIdeation.config?.includeKanbanContext ??
					true,
				maxIdeasPerType:
					rawIdeation.config?.max_ideas_per_type ||
					rawIdeation.config?.maxIdeasPerType ||
					5,
			},
			ideas: (rawIdeation.ideas || []).map((idea) =>
				transformIdeaFromSnakeCase(idea),
			),
			projectContext: {
				existingFeatures:
					rawIdeation.project_context?.existing_features ||
					rawIdeation.projectContext?.existingFeatures ||
					[],
				techStack:
					rawIdeation.project_context?.tech_stack ||
					rawIdeation.projectContext?.techStack ||
					[],
				targetAudience:
					rawIdeation.project_context?.target_audience ||
					rawIdeation.projectContext?.targetAudience,
				plannedFeatures:
					rawIdeation.project_context?.planned_features ||
					rawIdeation.projectContext?.plannedFeatures ||
					[],
			},
			generatedAt: rawIdeation.generated_at
				? new Date(rawIdeation.generated_at)
				: new Date(),
			updatedAt: rawIdeation.updated_at
				? new Date(rawIdeation.updated_at)
				: new Date(),
		};

		return { success: true, data: session };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Failed to read ideation",
		};
	}
}
