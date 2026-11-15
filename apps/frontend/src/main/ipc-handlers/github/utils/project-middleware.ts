/**
 * Project validation middleware for GitHub handlers
 *
 * Provides consistent project validation and error handling across all handlers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../../../../shared/types";
import { projectStore } from "../../../project-store";
import { featureProject } from "../../server-feature-files";

/**
 * Validate that a project path is safe for file operations
 * Ensures the path is absolute and is an existing directory
 */
function validateProjectPath(projectPath: string): void {
	// Ensure path is absolute
	if (!path.isAbsolute(projectPath)) {
		throw new Error(`Project path must be absolute: ${projectPath}`);
	}

	// An absolute path keeps no `..` segment once normalized: refusing a path
	// that still contains ".." only refused folder names such as `my..app`.
	const normalizedPath = path.normalize(projectPath);

	// Verify path exists and is a directory
	if (!fs.existsSync(normalizedPath)) {
		throw new Error(`Project path does not exist: ${projectPath}`);
	}

	const stats = fs.statSync(normalizedPath);
	if (!stats.isDirectory()) {
		throw new Error(`Project path is not a directory: ${projectPath}`);
	}
}

/**
 * Execute a handler with project validation, returning null on missing project
 *
 * Usage for handlers that should return null instead of throwing:
 * ```ts
 * ipcMain.handle('channel', async (_, projectId: string) => {
 *   return withProjectOrNull(projectId, async (project) => {
 *     // Your handler logic here
 *     return someResult;
 *   });
 * });
 * ```
 */
export async function withProjectOrNull<T>(
	projectId: string,
	handler: (project: Project) => Promise<T>,
): Promise<T | null> {
	const project = projectStore.getProject(projectId);
	if (!project) {
		return null;
	}

	// Validate project path before passing to handler
	try {
		validateProjectPath(project.path);
	} catch {
		return null;
	}

	return handler(project);
}

/**
 * {@link withProjectOrNull} for the GitHub views that also work on a server
 * project (server mode). Its calls go through the server (`server-relay.ts`)
 * and nothing is read from or run in its folder, the app's mirror, so a
 * handler that reads the folder or runs a tool there keeps `withProjectOrNull`.
 */
export async function withForgeProjectOrNull<T>(
	projectId: string,
	handler: (project: Project) => Promise<T>,
): Promise<T | null> {
	const project = featureProject(projectId);
	if (project?.remote) return handler(project);
	return withProjectOrNull(projectId, handler);
}
