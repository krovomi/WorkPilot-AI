import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { AUTO_BUILD_PATHS, IPC_CHANNELS } from "../../../shared/constants";
import type {
	IPCResult,
	Project,
	ProjectContextData,
	ProjectIndex,
} from "../../../shared/types";
import { getAugmentedEnv } from "../../env-utils";
import { parsePythonCommand } from "../../python-detector";
import { getConfiguredPythonPath } from "../../python-env-manager";
import { getEffectiveSourcePath } from "../../updater/path-resolver";
import { featureProject } from "../server-feature-files";
import { fetchBrainMemoryStatus, loadBrainMemories } from "./brain-memory";
import {
	fetchServerMemories,
	mirroredIndex,
	pullServerIndex,
	rebuildServerIndex,
} from "./server-context";

/**
 * Load project index from file
 */
function loadProjectIndex(projectPath: string): ProjectIndex | null {
	const indexPath = path.join(projectPath, AUTO_BUILD_PATHS.PROJECT_INDEX);
	if (!existsSync(indexPath)) {
		return null;
	}

	try {
		const content = readFileSync(indexPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * The context of a server project: its index as the server has it, its
 * memories from its own brain there (`server-context.ts`).
 */
async function serverProjectContext(
	project: Project,
): Promise<IPCResult<ProjectContextData>> {
	const pulled = await pullServerIndex(project);
	if (pulled) return { success: false, error: pulled };
	const memories = await fetchServerMemories(project, { limit: 20 });
	if (!memories.success || !memories.data) {
		return { success: false, error: memories.error ?? "Server unavailable" };
	}
	return {
		success: true,
		data: {
			projectIndex: mirroredIndex(project),
			memoryStatus: memories.data.status,
			memoryState: null,
			recentMemories: memories.data.memories,
			isLoading: false,
		},
	};
}

/**
 * Register project context handlers
 */
export function registerProjectContextHandlers(
	_getMainWindow: () => BrowserWindow | null,
): void {
	// Get full project context
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_GET,
		async (_, projectId: string): Promise<IPCResult<ProjectContextData>> => {
			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			if (project.remote) return serverProjectContext(project);

			try {
				// Load project index
				const projectIndex = loadProjectIndex(project.path);

				// The project's memory: the shared brain, the one store
				const [memoryStatus, recentMemories] = await Promise.all([
					fetchBrainMemoryStatus(),
					loadBrainMemories(project.path, 20),
				]);

				return {
					success: true,
					data: {
						projectIndex,
						memoryStatus,
						memoryState: null,
						recentMemories,
						isLoading: false,
					},
				};
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to load project context",
				};
			}
		},
	);

	// Refresh project index
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_REFRESH_INDEX,
		async (_, projectId: string): Promise<IPCResult<ProjectIndex>> => {
			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			if (project.remote) return rebuildServerIndex(project);

			try {
				// Run the analyzer script to regenerate project_index.json
				const autoBuildSource = getEffectiveSourcePath();

				if (!autoBuildSource) {
					return {
						success: false,
						error: "Auto-build source path not configured",
					};
				}

				const analyzerPath = path.join(autoBuildSource, "analyzer.py");
				const indexOutputPath = path.join(
					project.path,
					AUTO_BUILD_PATHS.PROJECT_INDEX,
				);

				// Get configured Python path (venv if ready, otherwise bundled/system)
				// This ensures we use the venv Python which has dependencies installed
				const pythonCmd = getConfiguredPythonPath();

				const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonCmd);

				// Run analyzer
				await new Promise<void>((resolve, reject) => {
					let stdout = "";
					let stderr = "";

					const proc = spawn(
						pythonCommand,
						[
							...pythonBaseArgs,
							analyzerPath,
							"--project-dir",
							project.path,
							"--output",
							indexOutputPath,
						],
						{
							cwd: project.path,
							env: {
								...getAugmentedEnv(),
								PYTHONIOENCODING: "utf-8",
								PYTHONUTF8: "1",
							},
						},
					);

					proc.stdout?.on("data", (data) => {
						stdout += data.toString("utf-8");
					});

					proc.stderr?.on("data", (data) => {
						stderr += data.toString("utf-8");
					});

					proc.on("close", (code: number) => {
						if (code === 0) {
							resolve();
						} else {
							console.error(
								"[project-context] Analyzer failed with code",
								code,
							);
							console.error("[project-context] Analyzer stderr:", stderr);
							console.error("[project-context] Analyzer stdout:", stdout);
							reject(
								new Error(
									`Analyzer exited with code ${code}: ${stderr || stdout}`,
								),
							);
						}
					});

					proc.on("error", (err) => {
						console.error("[project-context] Analyzer spawn error:", err);
						reject(err);
					});
				});

				// Read the new index
				const projectIndex = loadProjectIndex(project.path);
				if (projectIndex) {
					return { success: true, data: projectIndex };
				}

				return { success: false, error: "Failed to generate project index" };
			} catch (error) {
				return {
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to refresh project index",
				};
			}
		},
	);
}
