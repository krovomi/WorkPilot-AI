/**
 * Flaky Tests IPC Handlers
 *
 * Spawns the Python flaky tests runner and forwards events.
 *
 * Channels:
 *   invoke "flakyTests:run"     → FlakyRunOptions (scan the reports, or run a
 *                                 detected test command N times)
 *   invoke "flakyTests:detect"  → { projectPath } → FlakyDetectResult
 *   invoke "flakyTests:cancel"  → void
 *
 * Renderer events:
 *   flaky-tests-event     (progress / start / complete metadata)
 *   flaky-tests-result    (full FlakyReport JSON)
 *   flaky-tests-error     (string)
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { requirePythonPath } from "../utils/ensure-python";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import {
	FLAKY_COMMAND_IDS,
	FLAKY_MAX_RUNS,
	FLAKY_MIN_RUNS,
	type DetectedTestCommand,
	type FlakyCommandId,
	type FlakyDetectResult,
} from "../../shared/types/flaky-tests";
import { isWindows } from "../platform";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import {
	cancelServerAnalysis,
	relayServerAnalysis,
	serverProjectAtPath,
} from "./server-analyses";

const EVENT_PREFIX = "FLAKY_EVENT:";
const RESULT_PREFIX = "FLAKY_RESULT:";
const ERROR_PREFIX = "FLAKY_ERROR:";
const DETECT_TIMEOUT_MS = 30_000;

/** A run request once the main process has checked it (the renderer is not trusted). */
export interface CheckedRunRequest {
	projectPath: string;
	mode: "scan" | "run";
	runs: number;
	commandId: FlakyCommandId | "auto";
}

/**
 * Check what the renderer sent: a known mode, a bounded number of runs and
 * the id of a command the runner detects itself. The renderer never sends a
 * command line (docs/rules/security.md, S6). Throws on anything else.
 */
export function checkRunRequest(raw: unknown): CheckedRunRequest {
	const req = (raw ?? {}) as Record<string, unknown>;
	const projectPath = req.projectPath;
	if (typeof projectPath !== "string" || !projectPath) {
		throw new Error("projectPath is required");
	}
	const mode = req.mode ?? "scan";
	if (mode !== "scan" && mode !== "run") {
		throw new Error("mode must be scan or run");
	}
	const rawRuns = req.runs ?? 5;
	if (typeof rawRuns !== "number" || !Number.isInteger(rawRuns)) {
		throw new Error("runs must be an integer");
	}
	const runs = Math.min(FLAKY_MAX_RUNS, Math.max(FLAKY_MIN_RUNS, rawRuns));
	const commandId = req.commandId ?? "auto";
	if (
		commandId !== "auto" &&
		!(FLAKY_COMMAND_IDS as readonly unknown[]).includes(commandId)
	) {
		throw new Error("unknown test command");
	}
	return {
		projectPath,
		mode,
		runs,
		commandId: commandId as FlakyCommandId | "auto",
	};
}

/** The runner's arguments after its path. */
export function runnerArgs(req: CheckedRunRequest): string[] {
	const args = ["--project-path", req.projectPath];
	if (req.mode === "run") {
		args.push(
			"--mode",
			"run",
			"--runs",
			String(req.runs),
			"--command-id",
			req.commandId,
		);
	}
	return args;
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

/** The runner and what it started (dotnet's test host, node workers). */
function killTree(child: ChildProcess): void {
	if (isWindows() && child.pid) {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
			/* already gone */
		});
		return;
	}
	// The runner stops the suite it started on SIGTERM.
	child.kill("SIGTERM");
}

async function spawnRunner(args: string[]): Promise<ChildProcess> {
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runnerPath = path.resolve(backendPath, "runners", "flaky_tests_runner.py");
	const pythonExe = await requirePythonPath();
	return spawn(pythonExe, [runnerPath, ...args], {
		cwd: backendPath,
		env: await pythonRunnerEnv(backendPath),
	} as Parameters<typeof spawn>[2]);
}

/** Calls ``onLine`` for each complete line the child prints. */
function readLines(child: ChildProcess, onLine: (line: string) => void): void {
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx >= 0) {
			const line = buffer.slice(0, newlineIdx).trim();
			buffer = buffer.slice(newlineIdx + 1);
			newlineIdx = buffer.indexOf("\n");
			if (line) onLine(line);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[FlakyTests] stderr:", chunk.toString());
	});
}

/** The runner prints its error as a JSON string; older ones printed it raw. */
export function decodeRunnerError(raw: string): string {
	if (raw.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(raw);
			if (typeof decoded === "string") return decoded;
		} catch {
			/* not JSON after all */
		}
	}
	return raw;
}

export function registerFlakyTestsHandlers(): void {
	let currentProcess: ChildProcess | null = null;

	const killExisting = (): void => {
		cancelServerAnalysis("flaky-tests");
		if (currentProcess) {
			killTree(currentProcess);
			currentProcess = null;
		}
	};

	ipcMain.handle(IPC_CHANNELS.FLAKY_TESTS_RUN, async (_event, raw: unknown) => {
		killExisting();

		let req: CheckedRunRequest;
		try {
			req = checkRunRequest(raw);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			broadcast(IPC_CHANNELS.FLAKY_TESTS_ERROR, message);
			throw err;
		}

		// A server project's analysis runs on the server (`server-analyses.ts`).
		const remote = serverProjectAtPath(req.projectPath);
		if (remote) {
			const options =
				req.mode === "run"
					? { mode: "run", runs: req.runs, command_id: req.commandId }
					: {};
			return relayServerAnalysis(remote, "flaky-tests", options, {
				event: IPC_CHANNELS.FLAKY_TESTS_EVENT,
				result: IPC_CHANNELS.FLAKY_TESTS_RESULT,
				error: IPC_CHANNELS.FLAKY_TESTS_ERROR,
			});
		}

		const child = await spawnRunner(runnerArgs(req));
		currentProcess = child;

		let result: unknown = null;
		let errorMessage: string | null = null;
		readLines(child, (line) => {
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
				errorMessage = decodeRunnerError(line.slice(ERROR_PREFIX.length));
			}
		});

		return new Promise((resolve, reject) => {
			child.on("close", (code) => {
				if (currentProcess === child) currentProcess = null;
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
				if (currentProcess === child) currentProcess = null;
				const message = `Failed to start flaky tests runner: ${err.message}`;
				broadcast(IPC_CHANNELS.FLAKY_TESTS_ERROR, message);
				reject(new Error(message));
			});
		});
	});

	ipcMain.handle(
		IPC_CHANNELS.FLAKY_TESTS_DETECT,
		async (_event, raw: unknown): Promise<FlakyDetectResult> => {
			const projectPath = (raw as { projectPath?: unknown } | null)?.projectPath;
			if (typeof projectPath !== "string" || !projectPath) {
				throw new Error("projectPath is required");
			}
			if (serverProjectAtPath(projectPath)) {
				return { commands: [], remote: true };
			}
			const child = await spawnRunner([
				"--project-path",
				projectPath,
				"--mode",
				"detect",
			]);
			let commands: DetectedTestCommand[] = [];
			readLines(child, (line) => {
				if (!line.startsWith(RESULT_PREFIX)) return;
				try {
					const parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
					if (Array.isArray(parsed?.detectedCommands)) {
						commands = parsed.detectedCommands;
					}
				} catch (err) {
					console.error("[FlakyTests] Bad detect line:", err);
				}
			});
			return new Promise((resolve) => {
				const timer = setTimeout(() => killTree(child), DETECT_TIMEOUT_MS);
				const done = () => {
					clearTimeout(timer);
					resolve({ commands, remote: false });
				};
				child.on("close", done);
				child.on("error", done);
			});
		},
	);

	ipcMain.handle(IPC_CHANNELS.FLAKY_TESTS_CANCEL, () => {
		killExisting();
		return true;
	});
}
