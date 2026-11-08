/**
 * Documentation IPC handlers: the "Documentation" tab of Docs et dérive.
 *
 * Runs `runners/documentation_runner.py` (coverage of the project or of a
 * file, draft doc comments, folder README) in the managed Python. The tab
 * used to fetch a relative `/api/documentation/...` URL from the renderer,
 * which never reached the backend in the desktop app.
 *
 * Channels:
 *   invoke "documentation:run"     → { projectPath, action, path? } → result
 *   invoke "documentation:cancel"  → void
 * Renderer event:
 *   "documentation:progress"       → status string
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { DocumentationRequest } from "../../shared/types/documentation";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const ACTIONS = new Set(["project", "coverage", "docstrings", "readme"]);
const EVENT_PREFIX = "DOCUMENTATION_EVENT:";
const RESULT_PREFIX = "DOCUMENTATION_RESULT:";
const ERROR_PREFIX = "DOCUMENTATION_ERROR:";

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(channel, payload);
	}
}

/** Validates the request; the runner re-checks that `path` stays in the project. */
export function documentationArgs(request: DocumentationRequest): string[] {
	const { projectPath, action, path: target } = request ?? ({} as DocumentationRequest);
	if (typeof projectPath !== "string" || !projectPath.trim() || projectPath.startsWith("-")) {
		throw new Error("projectPath is required");
	}
	if (!ACTIONS.has(action)) throw new Error(`Unknown documentation action: ${String(action)}`);
	const args = ["--project-path", projectPath, "--action", action];
	if (action !== "project") {
		const relative = typeof target === "string" ? target.trim() : "";
		if (!relative && action !== "readme") throw new Error("path is required");
		if (relative.startsWith("-")) throw new Error("path must not start with '-'");
		args.push(`--path=${relative}`);
	}
	return args;
}

export function registerDocumentationHandlers(): void {
	let current: ChildProcess | null = null;

	ipcMain.handle(IPC_CHANNELS.DOCUMENTATION_RUN, async (_event, request: DocumentationRequest) => {
		const args = documentationArgs(request);
		current?.kill("SIGTERM");
		const backend = backendPath();
		const pythonExe = await requirePythonPath();
		const runner = path.resolve(backend, "runners", "documentation_runner.py");
		const child = spawn(pythonExe, [runner, ...args], {
			cwd: backend,
			env: await pythonRunnerEnv(backend),
		} as Parameters<typeof spawn>[2]);
		current = child;

		return new Promise((resolve, reject) => {
			let buffer = "";
			let result: unknown = null;
			let error: string | null = null;
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf("\n");
					if (line.startsWith(RESULT_PREFIX)) {
						try {
							result = JSON.parse(line.slice(RESULT_PREFIX.length));
						} catch (err) {
							error = `Unreadable documentation result: ${String(err)}`;
						}
					} else if (line.startsWith(ERROR_PREFIX)) {
						error = line.slice(ERROR_PREFIX.length);
					} else if (line.startsWith(EVENT_PREFIX)) {
						try {
							const event = JSON.parse(line.slice(EVENT_PREFIX.length));
							if (event?.data?.status) {
								broadcast(IPC_CHANNELS.DOCUMENTATION_PROGRESS, event.data.status);
							}
						} catch {
							/* a malformed progress line only loses that status */
						}
					}
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-2000);
			});
			child.on("error", (err) => {
				if (current === child) current = null;
				reject(new Error(`Failed to start the documentation runner: ${err.message}`));
			});
			child.on("close", (code) => {
				if (current === child) current = null;
				if (code === 0 && result) resolve(result);
				else
					reject(
						new Error(
							error ??
								(stderr.trim().split("\n").pop() ||
									`documentation runner exited with code ${code}`),
						),
					);
			});
		});
	});

	ipcMain.handle(IPC_CHANNELS.DOCUMENTATION_CANCEL, () => {
		current?.kill("SIGTERM");
		current = null;
		return true;
	});
}
