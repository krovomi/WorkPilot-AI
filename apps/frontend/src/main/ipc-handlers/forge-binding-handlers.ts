/**
 * `git:forgeBindings`: a project's forge settings (GitHub, GitLab, Azure
 * DevOps) checked against the remotes of its checkout, so the settings page
 * can say "this project points at another repository" and offer the
 * project's own (`forge/project-forge-binding.ts`).
 *
 * The renderer names a registered project by id and may send the values the
 * page shows (bounded strings, compared, never saved here): the path, the
 * settings file and the git command are the main process's.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult, ProjectForgeBindings } from "../../shared/types";
import { listGitRemotes, projectForgeBindings } from "../forge/project-forge-binding";
import { getProjectEnvPath, readProjectEnvFile } from "../project-env-file";
import { projectStore } from "../project-store";
import { normalizeRepoReference } from "./github/utils";
import { normalizeProjectReference } from "./gitlab/utils";

const MAX_PROJECT_ID_LENGTH = 200;
const MAX_VALUE_LENGTH = 1024;

/**
 * The page's unsaved values that take the place of the file's, by the
 * settings key they would be saved under: what the person is typing is
 * checked before it is saved. Only these strings, bounded; anything else is
 * ignored.
 */
const CURRENT_KEYS = {
	githubRepo: "GITHUB_REPO",
	gitlabProject: "GITLAB_PROJECT",
	gitlabInstanceUrl: "GITLAB_INSTANCE_URL",
	azureDevOpsOrgUrl: "AZURE_DEVOPS_ORG_URL",
	azureDevOpsProject: "AZURE_DEVOPS_PROJECT",
	azureDevOpsRepository: "AZURE_DEVOPS_REPOSITORY",
} as const;

export function currentValues(current: unknown): Record<string, string> {
	const values: Record<string, string> = {};
	if (!current || typeof current !== "object" || Array.isArray(current)) return values;
	for (const [field, key] of Object.entries(CURRENT_KEYS)) {
		const value = (current as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) values[key] = value;
	}
	return values;
}

export function forgeBindingsFor(
	projectId: unknown,
	current?: unknown,
): IPCResult<ProjectForgeBindings> {
	if (
		typeof projectId !== "string" ||
		projectId.length === 0 ||
		projectId.length > MAX_PROJECT_ID_LENGTH
	) {
		return { success: false, error: "Invalid project id" };
	}
	const project = projectStore.getProject(projectId);
	if (!project) return { success: false, error: "Project not found" };
	// A server project's forge is the server's; its checkout is not here.
	if (project.remote) return { success: false, error: "Not a local project" };
	const envPath = getProjectEnvPath(project);
	const vars = { ...(envPath ? readProjectEnvFile(envPath) : {}), ...currentValues(current) };
	return {
		success: true,
		data: projectForgeBindings(vars, listGitRemotes(project.path), {
			githubRepo: normalizeRepoReference,
			gitlabProject: normalizeProjectReference,
		}),
	};
}

export function registerForgeBindingHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.GIT_FORGE_BINDINGS,
		(_event, projectId: unknown, current?: unknown): IPCResult<ProjectForgeBindings> =>
			forgeBindingsFor(projectId, current),
	);
}
