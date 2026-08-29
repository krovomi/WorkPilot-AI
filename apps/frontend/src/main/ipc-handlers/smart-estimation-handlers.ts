/**
 * Smart Estimation IPC Handlers
 *
 * Handles IPC communication for the Smart Estimation feature
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import { projectStore } from "../project-store";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";

interface SmartEstimationRequest {
	projectId: string;
	taskDescription: string;
}

export function setupSmartEstimationHandlers() {
	let currentProcess: ChildProcess | null = null;

	// Kill existing process when starting a new one
	const killExistingProcess = () => {
		if (currentProcess) {
			currentProcess.kill("SIGTERM");
			currentProcess = null;
		}
	};

	// Resolve backend path once (same candidates as conflict-predictor-handlers,
	// which is the pattern that survives a packaged build).
	const getBackendPath = (): string => {
		const candidates = [
			...(app.isPackaged ? [join(process.resourcesPath, "backend")] : []),
			join(__dirname, "..", "..", "..", "backend"),
			join(app.getAppPath(), "..", "backend"),
			join(process.cwd(), "apps", "backend"),
		];
		return (
			candidates.find((p) => existsSync(p)) ??
			candidates.at(-1) ??
			candidates[0]
		);
	};

	// Handle smart estimation request
	ipcMain.handle(
		"run-smart-estimation",
		async (event, { projectId, taskDescription }: SmartEstimationRequest) => {
			return new Promise((resolve, reject) => {
				killExistingProcess();

				// The backend has no registry of Electron project ids; it needs the
				// path, which only this side knows.
				const project = projectStore.getProject(projectId);
				if (!project) {
					const errorMessage = `Project not found: ${projectId}`;
					event.sender.send("smart-estimation-error", errorMessage);
					reject(new Error(errorMessage));
					return;
				}

				const backendPath = getBackendPath();
				const runnerPath = join(
					backendPath,
					"runners",
					"smart_estimation_runner.py",
				);

				const [pythonCommand, pythonBaseArgs] = parsePythonCommand(
					getConfiguredPythonPath(),
				);
				const spawnedProcess: ChildProcess = spawn(
					pythonCommand,
					[
						...pythonBaseArgs,
						runnerPath,
						"--project-path",
						project.path,
						"--task-description",
						taskDescription,
					],
					{
						cwd: backendPath,
						env: {
							...process.env,
							PYTHONPATH: backendPath,
						},
					} as Parameters<typeof spawn>[2],
				);

				currentProcess = spawnedProcess;

				// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
				let result: any = null;
				let error: string | null = null;

				// Handle stdout events
				spawnedProcess.stdout?.on("data", (data: Buffer) => {
					const output = data.toString();

					// Parse smart estimation events
					const lines = output.split("\n");
					for (const line of lines) {
						if (line.startsWith("SMART_ESTIMATION_EVENT:")) {
							try {
								const eventData = JSON.parse(
									line.substring("SMART_ESTIMATION_EVENT:".length),
								);
								event.sender.send("smart-estimation-event", eventData);
							} catch (e) {
								console.error("Failed to parse smart estimation event:", e);
							}
						} else if (line.startsWith("SMART_ESTIMATION_RESULT:")) {
							try {
								result = JSON.parse(
									line.substring("SMART_ESTIMATION_RESULT:".length),
								);
							} catch (e) {
								console.error("Failed to parse smart estimation result:", e);
							}
						} else if (line.startsWith("SMART_ESTIMATION_ERROR:")) {
							error = line.substring("SMART_ESTIMATION_ERROR:".length);
						}
					}
				});

				// Handle stderr. Warnings land here too (Python logging writes to
				// stderr), so it is kept as context for a failed exit rather than
				// reported as an error on its own — otherwise a successful run that
				// logged one warning would surface as a failure.
				let stderrBuffer = "";
				spawnedProcess.stderr?.on("data", (data: Buffer) => {
					const errorOutput = data.toString();
					stderrBuffer += errorOutput;
					console.warn("Smart Estimation stderr:", errorOutput);
				});

				// Handle process completion
				spawnedProcess.on("close", (code: number | null) => {
					currentProcess = null;

					if (code === 0 && result) {
						event.sender.send("smart-estimation-complete", result);
						resolve(result);
					} else {
						const errorMessage =
							error ||
							stderrBuffer.trim() ||
							`Process exited with code ${code}`;
						event.sender.send("smart-estimation-error", errorMessage);
						reject(new Error(errorMessage));
					}
				});

				// Handle process error
				spawnedProcess.on("error", (err: Error) => {
					currentProcess = null;
					const errorMessage = `Failed to start smart estimation process: ${err.message}`;
					event.sender.send("smart-estimation-error", errorMessage);
					reject(new Error(errorMessage));
				});
			});
		},
	);

	// Handle process cancellation
	ipcMain.handle("cancel-smart-estimation", () => {
		killExistingProcess();
		return true;
	});

	return () => {
		killExistingProcess();
		ipcMain.removeAllListeners("run-smart-estimation");
		ipcMain.removeAllListeners("cancel-smart-estimation");
	};
}
