/**
 * Quality Scorer IPC handlers.
 *
 * The renderer names a project by id and the files a pull request changes;
 * the main process finds the project's folder itself (the renderer is not
 * trusted with a path, docs/rules/security.md S6) and runs the backend's
 * `runners/quality_score_runner.py` there with the managed Python. The score
 * is static analysis: the runner calls no model and gets no credential.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { logger } from "../app-logger";
import { projectStore } from "../project-store";
import { requirePythonPath } from "../utils/ensure-python";
import { envWithoutCredentials } from "../utils/child-env";

const RESULT = "QUALITY_RESULT:";
const ERROR = "QUALITY_ERROR:";
const TIMEOUT_MS = 120_000;
const MAX_FILES = 500;

interface QualityAnalyzeParams {
	files: string[];
	projectId?: string;
}

interface QualityAnalyzePRParams {
	prNumber: number;
	changedFiles: string[];
	projectId?: string;
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** The project's folder, from its id; never a path from the renderer. */
function projectFolder(projectId: unknown): string {
	const project =
		typeof projectId === "string" ? projectStore.getProject(projectId) : undefined;
	if (!project?.path) throw new Error("Unknown project");
	return project.path;
}

function fileList(files: unknown): string[] {
	if (!Array.isArray(files)) return [];
	return files
		.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length < 1024)
		.slice(0, MAX_FILES);
}

/** Read the runner's answer from its output. */
export function parseQualityOutput(stdout: string): unknown {
	const lines = stdout.split(/\r?\n/);
	const error = lines.find((l) => l.startsWith(ERROR));
	if (error) throw new Error(error.slice(ERROR.length));
	const result = lines.find((l) => l.startsWith(RESULT));
	if (!result) throw new Error("The quality analysis returned no result");
	return JSON.parse(result.slice(RESULT.length));
}

async function runQualityAnalysis(projectId: unknown, files: unknown): Promise<unknown> {
	const projectDir = projectFolder(projectId);
	const python = await requirePythonPath();
	const backend = backendPath();
	const args = [
		path.join(backend, "runners", "quality_score_runner.py"),
		"--project-dir",
		projectDir,
		"--files",
		...fileList(files),
	];
	return new Promise((resolve, reject) => {
		const proc = spawn(python, args, {
			cwd: backend,
			env: envWithoutCredentials(process.env, { PYTHONUTF8: "1" }),
			timeout: TIMEOUT_MS,
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString("utf-8");
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString("utf-8")).slice(-4000);
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			try {
				resolve(parseQualityOutput(stdout));
			} catch (error) {
				logger.warn("Quality analysis failed", { code, stderr });
				reject(error);
			}
		});
	});
}

export function setupQualityHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.QUALITY_ANALYZE, (_, params: QualityAnalyzeParams) =>
		runQualityAnalysis(params?.projectId, params?.files),
	);
	ipcMain.handle(IPC_CHANNELS.QUALITY_ANALYZE_PR, (_, params: QualityAnalyzePRParams) =>
		runQualityAnalysis(params?.projectId, params?.changedFiles),
	);
}
