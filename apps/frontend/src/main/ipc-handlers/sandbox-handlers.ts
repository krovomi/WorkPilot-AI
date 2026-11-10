/**
 * Sandbox IPC Handlers
 *
 * Spawns the Python sandbox runner, which produces a SimulationResult in one
 * of two modes: the uncommitted changes of the project (git diff HEAD), or,
 * when a spec is named, a rehearsal of that spec's implementation plan over
 * the files of a git ref (apps/backend/simulation).
 *
 * Channels:
 *   invoke "sandbox:run"     → { projectPath, specId?, baseRef? }
 *   invoke "sandbox:cancel"  → void
 *
 * Renderer events:
 *   sandbox-event
 *   sandbox-result
 *   sandbox-error
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { requirePythonPath } from "../utils/ensure-python";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { pythonRunnerEnv } from "../utils/python-runner-env";
import { findSpecDir } from "./bounty-board-handlers";

interface RunRequest {
	projectPath: string;
	specId?: string;
	baseRef?: string;
}

// Same rule as the runner's: a ref, never an option disguised as one.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,199}$/;

/**
 * The runner arguments for a request from the renderer, revalidated here.
 *
 * The renderer only offers projects and specs that exist, but this is the one
 * place every call goes through: a relative project path, a spec id that names
 * no spec folder of that project, or a ref that starts with a dash is refused
 * before any process starts.
 */
export function buildSandboxArgs(runnerPath: string, request: unknown): string[] {
	const { projectPath, specId, baseRef } = (request ?? {}) as Partial<RunRequest>;
	if (typeof projectPath !== "string" || !projectPath || !path.isAbsolute(projectPath)) {
		throw new Error("projectPath is required");
	}
	if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
		throw new Error("projectPath is not a folder");
	}
	const args = [runnerPath, "--project-path", projectPath];
	if (specId === undefined || specId === "") return args;
	if (typeof specId !== "string") throw new Error("specId must be a string");
	const specDir = findSpecDir(projectPath, specId);
	if (!specDir) throw new Error(`No spec named ${specId} in this project`);
	args.push("--spec-dir", specDir);
	const ref = typeof baseRef === "string" && baseRef.trim() ? baseRef.trim() : "HEAD";
	if (!SAFE_REF.test(ref)) throw new Error(`Not a git ref: ${ref}`);
	args.push("--base-ref", ref);
	return args;
}

/** The runner prints its error as JSON; older runners printed plain text. */
function readErrorLine(raw: string): string {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "string" ? parsed : raw;
	} catch {
		return raw;
	}
}

const EVENT_PREFIX = "SANDBOX_EVENT:";
const RESULT_PREFIX = "SANDBOX_RESULT:";
const ERROR_PREFIX = "SANDBOX_ERROR:";

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

export function registerSandboxHandlers(): void {
	let currentProcess: ChildProcess | null = null;

	const killExisting = (): void => {
		if (currentProcess) {
			currentProcess.kill("SIGTERM");
			currentProcess = null;
		}
	};

	ipcMain.handle(IPC_CHANNELS.SANDBOX_RUN, async (_event, request: unknown) => {
		killExisting();

		const backendPath = app.isPackaged
			? path.resolve(process.resourcesPath, "backend")
			: path.resolve(app.getAppPath(), "..", "backend");
		const runnerPath = path.resolve(
			backendPath,
			"runners",
			"sandbox_runner.py",
		);

		let args: string[];
		try {
			args = buildSandboxArgs(runnerPath, request);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			broadcast(IPC_CHANNELS.SANDBOX_ERROR, message);
			throw err instanceof Error ? err : new Error(message);
		}

		const pythonExe = await requirePythonPath();

		const child = spawn(
			pythonExe,
			args,
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
						broadcast(IPC_CHANNELS.SANDBOX_EVENT, payload);
					} catch (err) {
						console.error("[Sandbox] Bad event line:", err);
					}
				} else if (line.startsWith(RESULT_PREFIX)) {
					try {
						result = JSON.parse(line.slice(RESULT_PREFIX.length));
					} catch (err) {
						console.error("[Sandbox] Bad result line:", err);
					}
				} else if (line.startsWith(ERROR_PREFIX)) {
					errorMessage = readErrorLine(line.slice(ERROR_PREFIX.length));
				}
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			console.error("[Sandbox] stderr:", chunk.toString());
		});

		return new Promise((resolve, reject) => {
			child.on("close", (code) => {
				currentProcess = null;
				if (code === 0 && result) {
					broadcast(IPC_CHANNELS.SANDBOX_RESULT, result);
					resolve(result);
				} else {
					const message =
						errorMessage ?? `sandbox runner exited with code ${code}`;
					broadcast(IPC_CHANNELS.SANDBOX_ERROR, message);
					reject(new Error(message));
				}
			});

			child.on("error", (err) => {
				currentProcess = null;
				const message = `Failed to start sandbox runner: ${err.message}`;
				broadcast(IPC_CHANNELS.SANDBOX_ERROR, message);
				reject(new Error(message));
			});
		});
	});

	ipcMain.handle(IPC_CHANNELS.SANDBOX_CANCEL, () => {
		killExisting();
		return true;
	});
}
