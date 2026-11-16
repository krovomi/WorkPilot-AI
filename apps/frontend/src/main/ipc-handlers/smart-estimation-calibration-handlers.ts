/**
 * Smart Estimation calibration IPC handlers (issue #367).
 *
 * Two writes on a repository's calibration, both done by
 * `runners/estimation_calibration_runner.py`:
 *   invoke SMART_ESTIMATION_ADJUST             → { projectId, category, baseScore, adjustedScore }
 *   invoke SMART_ESTIMATION_RESET_CALIBRATION  → { projectId }
 *
 * The renderer names a project by id, never a path: the path comes from the
 * project store. The category is checked against the closed list and the
 * scores are whole numbers from 1 to 13, here and again in the runner. The
 * runner is spawned without a shell, with `pythonRunnerEnv`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	type CalibrationAdjustRequest,
	type CalibrationSummary,
	ESTIMATION_CATEGORIES,
	type EstimationCategory,
} from "../../shared/types/smart-estimation";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const RESULT_PREFIX = "ESTIMATION_CALIBRATION_RESULT:";
const ERROR_PREFIX = "ESTIMATION_CALIBRATION_ERROR:";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isScore(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 13;
}

/** The project's folder for an id the renderer sent; throws when unknown. */
export function projectPathFor(projectId: unknown): string {
	const project =
		typeof projectId === "string" ? projectStore.getProject(projectId) : undefined;
	if (!project) throw new Error("Unknown project");
	return project.path;
}

/** The runner arguments of an adjustment; throws on anything off the closed lists. */
export function adjustArgs(request: unknown): string[] {
	if (!isRecord(request)) throw new Error("Invalid adjustment");
	const { projectId, category, baseScore, adjustedScore } = request;
	if (!ESTIMATION_CATEGORIES.includes(category as EstimationCategory)) {
		throw new Error("Unknown estimation category");
	}
	if (!isScore(baseScore) || !isScore(adjustedScore)) {
		throw new Error("A complexity score is a whole number from 1 to 13");
	}
	return [
		"--project-path",
		projectPathFor(projectId),
		"--action",
		"adjust",
		"--category",
		category as string,
		"--base-score",
		String(baseScore),
		"--adjusted-score",
		String(adjustedScore),
	];
}

/** The runner arguments of a reset. */
export function resetArgs(request: unknown): string[] {
	const projectId = isRecord(request) ? request.projectId : undefined;
	return ["--project-path", projectPathFor(projectId), "--action", "reset"];
}

/** The summary in the runner's output, or the error it printed. */
export function parseRunnerOutput(stdout: string, code: number | null): CalibrationSummary {
	let error: string | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith(RESULT_PREFIX) && code === 0) {
			return JSON.parse(line.slice(RESULT_PREFIX.length)) as CalibrationSummary;
		}
		if (line.startsWith(ERROR_PREFIX)) error = line.slice(ERROR_PREFIX.length);
	}
	throw new Error(error ?? `Calibration runner exited with code ${code}`);
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** Run the calibration runner with *args* (already checked) and read its summary. */
export async function runCalibrationRunner(args: string[]): Promise<CalibrationSummary> {
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend);
	const [command, baseArgs] = parsePythonCommand(getConfiguredPythonPath());
	const child = spawn(
		command,
		[...baseArgs, path.join(backend, "runners", "estimation_calibration_runner.py"), ...args],
		{ cwd: backend, env },
	);
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		child.on("error", (err: Error) => reject(err));
		child.on("close", (code: number | null) => {
			try {
				resolve(parseRunnerOutput(stdout, code));
			} catch (err) {
				reject(err);
			}
		});
	});
}

export function registerSmartEstimationCalibrationHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SMART_ESTIMATION_ADJUST,
		async (_event, request: CalibrationAdjustRequest) =>
			runCalibrationRunner(adjustArgs(request)),
	);
	ipcMain.handle(
		IPC_CHANNELS.SMART_ESTIMATION_RESET_CALIBRATION,
		async (_event, request: { projectId: string }) =>
			runCalibrationRunner(resetArgs(request)),
	);
}
