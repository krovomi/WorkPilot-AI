/**
 * What every Bitbucket handler does first: the local project the renderer
 * names (a server project has no Bitbucket views), its config, and the answer
 * as an `IPCResult` that says why it failed — never with the token.
 */

import type { IPCResult, Project } from "../../../shared/types";
import { projectStore } from "../../project-store";
import { type BitbucketConfig, getBitbucketConfig } from "./utils";

export const NOT_CONFIGURED =
	"Bitbucket not configured. Set the workspace, repository and token in the project's Bitbucket settings.";

/** What a failure says: its message, else `fallback`. */
export const errorMessage = (error: unknown, fallback: string): string =>
	error instanceof Error ? error.message : fallback;

/** Runs `call` with the project and its config; a failed result when either is missing or `call` throws. */
export async function withBitbucketProject<T>(
	projectId: string,
	what: string,
	call: (config: BitbucketConfig, project: Project) => Promise<T>,
): Promise<IPCResult<T>> {
	const project = projectStore.getProject(projectId);
	if (!project) return { success: false, error: "Project not found" };
	const config = await getBitbucketConfig(project);
	if (!config) return { success: false, error: NOT_CONFIGURED };
	try {
		return { success: true, data: await call(config, project) };
	} catch (error) {
		return { success: false, error: errorMessage(error, `Failed to ${what}`) };
	}
}
