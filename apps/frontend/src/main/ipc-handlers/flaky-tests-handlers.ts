/**
 * Flaky Tests IPC Handlers
 *
 * Spawns the Python flaky tests runner and forwards events.
 *
 * Channels:
 *   invoke "flakyTests:run"     → { projectPath }
 *   invoke "flakyTests:cancel"  → void
 *
 * Renderer events:
 *   flaky-tests-event     (progress / start / complete metadata)
 *   flaky-tests-result    (full FlakyReport JSON)
 *   flaky-tests-error     (string)
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { pythonEnvManager } from "../python-env-manager.js";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import {
	cancelServerAnalysis,
	relayServerAnalysis,
	serverProjectAtPath,
} from "./server-analyses";

interface RunRequest {
	projectPath: string;
}

const EVENT_PREFIX = "FLAKY_EVENT:";
const RESULT_PREFIX = "FLAKY_RESULT:";
const ERROR_PREFIX = "FLAKY_ERROR:";

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

export function registerFlakyTestsHandlers(): void {
	let currentProcess: ChildProcess | null = null;

	const killExisting = (): void => {
		cancelServerAnalysis("flaky-tests");
		if (currentProcess) {
			currentProcess.kill("SIGTERM");
			currentProcess = null;
		}
	};

	ipcMain.handle(
		IPC_CHANNELS.FLAKY_TESTS_RUN,
		async (_event, { projectPath }: RunRequest) => {
			killExisting();

			if (!projectPath) {
				const message = "projectPath is required";
				broadcast(IPC_CHANNELS.FLAKY_TESTS_ERROR, message);
				throw new Error(message);
			}

			// A server project's analysis runs on the server (`server-analyses.ts`).
			const remote = serverProjectAtPath(projectPath);
			if (remote) {
				return relayServerAnalysis(remote, "flaky-tests", {}, {
					event: IPC_CHANNELS.FLAKY_TESTS_EVENT,
					result: IPC_CHANNELS.FLAKY_TESTS_RESULT,
					error: IPC_CHANNELS.FLAKY_TESTS_ERROR,
				});
			}

			const backendPath = app.isPackaged
				? path.resolve(process.resourcesPath, "backend")
				: path.resolve(app.getAppPath(), "..", "backend");
			const runnerPath = path.resolve(
				backendPath,
				"runners",
				"flaky_tests_runner.py",
			);

			const pythonExe = pythonEnvManager.getPythonPath();
			if (!pythonExe) {
				throw new Error("Python environment not ready");
			}

			const child = spawn(
				pythonExe,
				[runnerPath, "--project-path", projectPath],
				{
					cwd: backendPath,
					env: await pythonRunnerEnv(backendPath),
				} as Parameters<typeof spawn>[2],
			);
			currentProcess = child;

			let buffer = "";
			let result: unknown = null;
			let errorMessage: string | null = null;

			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				let newlineIdx = buffer.indexOf("\n");
				while (newlineIdx >= 0) {
					const line = buffer.slice(0, newlineIdx).trim();
					buffer = buffer.slice(newlineIdx + 1);
					newlineIdx = buffer.indexOf("\n");
					if (!line) continue;

					if (line.startsWith(EVENT_PREFIX)) {
						try {
							const payload = JSON.parse(line.slice(EVENT_PREFIX.length));
							broadcast(IPC_CHANNELS.FLAKY_TESTS_EVENT, payload);
						} catch (err) {
							console.error("[FlakyTests] Bad event line:", err);
						}
					} else if (line.startsWith(RESULT_PREFIX)) {
						try {
							result = JSON.parse(line.slice(RESULT_PREFIX.length));
						} catch (err) {
							console.error("[FlakyTests] Bad result line:", err);
						}
					} else if (line.startsWith(ERROR_PREFIX)) {
						errorMessage = line.slice(ERROR_PREFIX.length);
					}
				}
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				console.error("[FlakyTests] stderr:", chunk.toString());
			});

			return new Promise((resolve, reject) => {
				child.on("close", (code) => {
					currentProcess = null;
					if (code === 0 && result) {
						broadcast(IPC_CHANNELS.FLAKY_TESTS_RESULT, result);
						resolve(result);
					} else {
						const message =
							errorMessage ?? `flaky tests runner exited with code ${code}`;
						broadcast(IPC_CHANNELS.FLAKY_TESTS_ERROR, message);
						reject(new Error(message));
					}
				});

				child.on("error", (err) => {
					currentProcess = null;
					const message = `Failed to start flaky tests runner: ${err.message}`;
					broadcast(IPC_CHANNELS.FLAKY_TESTS_ERROR, message);
					reject(new Error(message));
				});
			});
		},
	);

	ipcMain.handle(IPC_CHANNELS.FLAKY_TESTS_CANCEL, () => {
		killExisting();
		return true;
	});
}
